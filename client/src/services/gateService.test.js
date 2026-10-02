import { db, countPendingSync } from '../db/database';
import { pullGateAttendance, gateEndpoint } from './gateService';

const DATE = '2026-08-27';

beforeEach(async () => {
  if (db.isOpen()) db.close();
  await db.delete();
  await db.open();
});

afterAll(async () => {
  if (db.isOpen()) db.close();
  await db.delete();
});

function fetchReturning(payload, { ok = true, status = 200 } = {}) {
  return jest.fn().mockResolvedValue({ ok, status, json: async () => payload });
}

const scan = (studentId, eventId, createdAt = `${DATE}T05:10:00Z`) => ({
  eventId, studentId, date: DATE, status: 'present', captureMethod: 'rfid',
  verified: false, recordedBy: null, reason: null, source: 'simulation', createdAt,
});

describe('pullGateAttendance', () => {
  it('fetches the class/day endpoint and merges the gate scans', async () => {
    const fetchImpl = fetchReturning({
      classGroupId: 'class-1',
      date: DATE,
      gate: { lastScanAt: `${DATE}T05:12:00Z` },
      records: [
        scan('stu-1', '11111111-1111-4111-8111-111111111111'),
        scan('stu-2', '22222222-2222-4222-8222-222222222222'),
      ],
    });

    const out = await pullGateAttendance('class-1', { date: DATE, fetchImpl });

    expect(fetchImpl.mock.calls[0][0]).toBe(gateEndpoint('class-1', DATE));
    expect(fetchImpl.mock.calls[0][0]).toBe(`/api/gate/classes/class-1/attendance?date=${DATE}`);
    expect(out.status).toBe('active');
    expect(out.scannedCount).toBe(2);
    expect(out.added).toEqual(['stu-1', 'stu-2']);
    expect(await db.attendanceEvents.count()).toBe(2);
    expect(await countPendingSync()).toBe(0);
  });

  it("reports 'no-scans' when the gate has not scanned anyone today", async () => {
    const fetchImpl = fetchReturning({ gate: { lastScanAt: '2026-08-26T05:00:00Z' }, records: [] });
    const out = await pullGateAttendance('class-1', { date: DATE, fetchImpl });
    expect(out.status).toBe('no-scans');
  });

  it("reports 'no-scans' when the gate has never scanned", async () => {
    const fetchImpl = fetchReturning({ gate: { lastScanAt: null }, records: [] });
    expect((await pullGateAttendance('class-1', { date: DATE, fetchImpl })).status).toBe('no-scans');
  });

  it("reports 'unreachable' without throwing when the network fails", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const out = await pullGateAttendance('class-1', { date: DATE, fetchImpl });
    expect(out.status).toBe('unreachable');
    expect(out.replaced).toEqual([]);
  });

  it("reports 'unreachable' on a server error", async () => {
    const fetchImpl = fetchReturning({}, { ok: false, status: 500 });
    expect((await pullGateAttendance('class-1', { date: DATE, fetchImpl })).status).toBe('unreachable');
  });

  it("reports 'unknown-class' when the gate does not have this class", async () => {
    const fetchImpl = fetchReturning({ error: 'class not found' }, { ok: false, status: 404 });
    expect((await pullGateAttendance('class-1', { date: DATE, fetchImpl })).status).toBe('unknown-class');
  });

  it('gives up after the timeout so the roll call is never blocked', async () => {
    const fetchImpl = jest.fn((url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const out = await pullGateAttendance('class-1', { date: DATE, fetchImpl, timeoutMs: 20 });
    expect(out.status).toBe('unreachable');
  });
});
