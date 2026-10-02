import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { db, todayISO, countPendingSync } from '../db/database';
import AttendanceForm from './AttendanceForm';

jest.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: { username: 'teacher.a' } }),
}));

const CLASS = 'class-1';
const TODAY = todayISO();

beforeEach(async () => {
  if (db.isOpen()) db.close();
  await db.delete();
  await db.open();
  await db.students.bulkAdd([
    { studentId: 'stu-1', classGroupId: CLASS, fullName: 'Amina Wanjiru', admissionNo: 'A/001' },
    { studentId: 'stu-2', classGroupId: CLASS, fullName: 'Kevin Odhiambo', admissionNo: 'A/002' },
  ]);
});

afterEach(() => {
  delete globalThis.fetch;
});

afterAll(async () => {
  if (db.isOpen()) db.close();
  await db.delete();
});

/** A gate server that has scanned Amina in and nobody else. */
function gateWithAminaScanned() {
  globalThis.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      classGroupId: CLASS,
      date: TODAY,
      gate: { lastScanAt: new Date().toISOString() },
      records: [{
        eventId: '11111111-1111-4111-8111-111111111111', studentId: 'stu-1', date: TODAY,
        status: 'present', captureMethod: 'fingerprint', verified: true, recordedBy: null,
        reason: null, source: 'simulation', createdAt: new Date().toISOString(),
      }],
    }),
  });
}

const rowFor = (name) => screen.getByText(name).closest('tr');
const tickFor = (name) => screen.getByRole('checkbox', { name: `${name} present` });

describe('AttendanceForm with the school gate', () => {
  it('shows gate scans as already present and only asks about the rest', async () => {
    gateWithAminaScanned();
    render(<AttendanceForm classGroupId={CLASS} />);

    expect(await screen.findByText(/1 of 2 scanned in at the gate/)).toBeInTheDocument();
    expect(within(rowFor('Amina Wanjiru')).getByText(/gate .* \(fingerprint\)/)).toBeInTheDocument();
    expect(tickFor('Amina Wanjiru')).toBeChecked();
    // no scan with the gate running: starts unticked (absent)
    expect(tickFor('Kevin Odhiambo')).not.toBeChecked();
    expect(within(rowFor('Kevin Odhiambo')).getByText(/not scanned/)).toBeInTheDocument();
    // gate scans are already on the server - nothing to push
    expect(await countPendingSync()).toBe(0);
  });

  it('marks a non-scanned student absent with a reason and confirms', async () => {
    gateWithAminaScanned();
    const user = userEvent.setup();
    render(<AttendanceForm classGroupId={CLASS} />);
    await screen.findByText(/1 of 2 scanned in at the gate/);

    // Kevin did not scan, so he is already unticked; the teacher adds a reason
    const reason = screen.getByRole('combobox', { name: 'Why was Kevin Odhiambo absent?' });
    await user.selectOptions(reason, 'fee');
    expect(reason).toHaveValue('fee');

    await user.click(screen.getByRole('button', { name: /Confirm attendance \(1\)/ }));

    await waitFor(async () => {
      const kevinRecord = await db.attendanceEvents.where('[studentId+date]').equals(['stu-2', TODAY]).first();
      expect(kevinRecord).toMatchObject({ status: 'absent', reason: 'fee', recordedBy: 'teacher.a' });
    });
    // only Kevin's mark goes up; Amina's gate scan is not re-sent
    expect(await countPendingSync()).toBe(1);
  });

  it('falls back to a full roll call when the gate cannot be reached', async () => {
    globalThis.fetch = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    render(<AttendanceForm classGroupId={CLASS} />);

    expect(await screen.findByText(/Can't reach the school gate/)).toBeInTheDocument();
    // full roll call: everyone starts ticked present, ready to save
    expect(tickFor('Amina Wanjiru')).toBeChecked();
    expect(tickFor('Kevin Odhiambo')).toBeChecked();
    expect(screen.getByRole('button', { name: 'Save attendance (2)' })).toBeEnabled();
  });

  it('tells the teacher when the gate overrode their offline mark', async () => {
    // teacher marked Amina absent while out of range...
    await db.attendanceEvents.add({
      eventId: '99999999-9999-4999-8999-999999999999', studentId: 'stu-1', date: TODAY,
      status: 'absent', captureMethod: 'manual', recordedBy: 'teacher.a', reason: null,
      syncedAt: null, createdAt: new Date().toISOString(),
    });
    await db.syncQueue.add({ eventId: '99999999-9999-4999-8999-999999999999', status: 'pending', createdAt: new Date().toISOString(), attemptCount: 0 });

    // ...but she had scanned in at the gate
    gateWithAminaScanned();
    render(<AttendanceForm classGroupId={CLASS} />);

    expect(await screen.findByText(/Amina Wanjiru scanned in at the gate at .* your "absent" mark was replaced/)).toBeInTheDocument();
    expect(await countPendingSync()).toBe(0);
  });
});
