import {
  db,
  addAttendanceEvent,
  addAttendanceBatch,
  DuplicateAttendanceError,
  countPendingSync,
  getAttendanceForDate,
  todayISO
} from './database';

const DATE = '2026-08-27';
const OTHER_DATE = '2026-08-28';

// fake-indexeddb keeps state for the lifetime of the process, so each test
// starts from a freshly recreated database.
beforeEach(async () => {
  if (db.isOpen()) db.close();
  await db.delete();
  await db.open();
});

afterAll(async () => {
  if (db.isOpen()) db.close();
  await db.delete();
});

describe('addAttendanceEvent - writing a record', () => {
  it('persists the event with a generated eventId and unsynced marker', async () => {
    const record = await addAttendanceEvent({
      studentId: 'stu-1',
      date: DATE,
      status: 'present',
      recordedBy: 'teacher.a'
    });

    expect(record.eventId).toEqual(expect.any(String));
    expect(record.syncedAt).toBeNull();

    const stored = await db.attendanceEvents.where('[studentId+date]').equals(['stu-1', DATE]).first();
    expect(stored).toMatchObject({
      studentId: 'stu-1',
      date: DATE,
      status: 'present',
      captureMethod: 'manual',
      recordedBy: 'teacher.a',
      syncedAt: null
    });
  });

  it('enqueues exactly one pending sync entry and one audit row per write', async () => {
    await addAttendanceEvent({ studentId: 'stu-1', date: DATE, status: 'present' });
    await addAttendanceEvent({ studentId: 'stu-2', date: DATE, status: 'absent' });

    expect(await countPendingSync()).toBe(2);
    expect(await db.auditLog.count()).toBe(2);

    const queued = await db.syncQueue.toArray();
    expect(queued.map((q) => q.status)).toEqual(['pending', 'pending']);
  });

  it('defaults captureMethod to "manual" and preserves an explicit one', async () => {
    await addAttendanceEvent({ studentId: 'stu-1', date: DATE, status: 'present' });
    await addAttendanceEvent({ studentId: 'stu-2', date: DATE, status: 'late', captureMethod: 'rfid' });

    const a = await db.attendanceEvents.where('studentId').equals('stu-1').first();
    const b = await db.attendanceEvents.where('studentId').equals('stu-2').first();
    expect(a.captureMethod).toBe('manual');
    expect(b.captureMethod).toBe('rfid');
  });

  it.each([
    ['missing studentId', { date: DATE, status: 'present' }, /studentId is required/],
    ['missing date', { studentId: 'stu-1', status: 'present' }, /date is required/],
    ['bad status', { studentId: 'stu-1', date: DATE, status: 'skipped' }, /status must be one of/]
  ])('rejects %s without writing anything', async (_label, event, message) => {
    await expect(addAttendanceEvent(event)).rejects.toThrow(message);
    expect(await db.attendanceEvents.count()).toBe(0);
    expect(await db.syncQueue.count()).toBe(0);
  });
});

describe('duplicate prevention', () => {
  it('throws DuplicateAttendanceError on a second write for the same student and date', async () => {
    await addAttendanceEvent({ studentId: 'stu-1', date: DATE, status: 'present' });

    await expect(
      addAttendanceEvent({ studentId: 'stu-1', date: DATE, status: 'absent' })
    ).rejects.toBeInstanceOf(DuplicateAttendanceError);
  });

  it('rolls the whole transaction back so the duplicate leaves no queue or audit trace', async () => {
    await addAttendanceEvent({ studentId: 'stu-1', date: DATE, status: 'present' });

    await addAttendanceEvent({ studentId: 'stu-1', date: DATE, status: 'late' }).catch(() => {});

    expect(await db.attendanceEvents.count()).toBe(1);
    expect(await countPendingSync()).toBe(1);
    expect(await db.auditLog.count()).toBe(1);

    const stored = await db.attendanceEvents.where('studentId').equals('stu-1').first();
    expect(stored.status).toBe('present'); // original value untouched
  });

  it('allows the same student on a different date', async () => {
    await addAttendanceEvent({ studentId: 'stu-1', date: DATE, status: 'present' });
    await expect(
      addAttendanceEvent({ studentId: 'stu-1', date: OTHER_DATE, status: 'present' })
    ).resolves.toMatchObject({ studentId: 'stu-1', date: OTHER_DATE });
  });

  it('allows different students on the same date', async () => {
    await addAttendanceEvent({ studentId: 'stu-1', date: DATE, status: 'present' });
    await expect(
      addAttendanceEvent({ studentId: 'stu-2', date: DATE, status: 'present' })
    ).resolves.toMatchObject({ studentId: 'stu-2' });
  });

  it('assigns a unique eventId to every accepted record', async () => {
    await addAttendanceEvent({ studentId: 'stu-1', date: DATE, status: 'present' });
    await addAttendanceEvent({ studentId: 'stu-2', date: DATE, status: 'present' });
    const ids = (await db.attendanceEvents.toArray()).map((r) => r.eventId);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('addAttendanceBatch - whole roll call', () => {
  it('saves every new record and reports duplicates without discarding the rest', async () => {
    await addAttendanceEvent({ studentId: 'stu-2', date: DATE, status: 'present' });

    const outcome = await addAttendanceBatch([
      { studentId: 'stu-1', date: DATE, status: 'present' },
      { studentId: 'stu-2', date: DATE, status: 'absent' }, // already recorded
      { studentId: 'stu-3', date: DATE, status: 'late' }
    ]);

    expect(outcome.saved.map((r) => r.studentId)).toEqual(['stu-1', 'stu-3']);
    expect(outcome.duplicates).toEqual(['stu-2']);
    expect(outcome.failed).toEqual([]);
    expect(await db.attendanceEvents.count()).toBe(3);
    expect(await countPendingSync()).toBe(3);
  });

  it('re-submitting an identical roll call saves nothing and flags all as duplicates', async () => {
    const roll = [
      { studentId: 'stu-1', date: DATE, status: 'present' },
      { studentId: 'stu-2', date: DATE, status: 'late' }
    ];
    await addAttendanceBatch(roll);
    const second = await addAttendanceBatch(roll);

    expect(second.saved).toEqual([]);
    expect(second.duplicates).toEqual(['stu-1', 'stu-2']);
    expect(await db.attendanceEvents.count()).toBe(2);
  });

  it('collects non-duplicate failures separately', async () => {
    const outcome = await addAttendanceBatch([
      { studentId: 'stu-1', date: DATE, status: 'present' },
      { studentId: 'stu-2', date: DATE, status: 'bogus' }
    ]);

    expect(outcome.saved.map((r) => r.studentId)).toEqual(['stu-1']);
    expect(outcome.duplicates).toEqual([]);
    expect(outcome.failed).toEqual([{ studentId: 'stu-2', reason: expect.stringMatching(/status must be one of/) }]);
  });
});

describe('getAttendanceForDate', () => {
  it('returns only records for students in the given class on that date', async () => {
    await db.students.bulkAdd([
      { studentId: 'stu-1', classGroupId: 'class-A', fullName: 'Ann', enrolledAt: '2026-01-06' },
      { studentId: 'stu-9', classGroupId: 'class-B', fullName: 'Zed', enrolledAt: '2026-01-06' }
    ]);
    await addAttendanceEvent({ studentId: 'stu-1', date: DATE, status: 'present' });
    await addAttendanceEvent({ studentId: 'stu-9', date: DATE, status: 'present' });

    const rows = await getAttendanceForDate('class-A', DATE);
    expect(rows.map((r) => r.studentId)).toEqual(['stu-1']);
  });
});

describe('todayISO', () => {
  it('formats a local date as YYYY-MM-DD without a UTC shift', () => {
    expect(todayISO(new Date(2026, 7, 27, 1, 30))).toBe('2026-08-27');
    expect(todayISO(new Date(2026, 0, 1, 23, 45))).toBe('2026-01-01');
  });
});
