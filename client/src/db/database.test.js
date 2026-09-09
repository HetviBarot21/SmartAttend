import {
  db,
  addAttendanceEvent,
  addAttendanceBatch,
  setAttendance,
  setAttendanceBatch,
  DuplicateAttendanceError,
  countPendingSync,
  getAttendanceForDate,
  getStudentsByClass,
  addStudent,
  updateStudent,
  removeStudent,
  setStudentCard,
  normalizeCardUid,
  getClasses,
  getClassById,
  createClass,
  updateClass,
  archiveClass,
  classLabel,
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

describe('setAttendance - editing during the day', () => {
  it('creates the record when none exists yet', async () => {
    const { record, changed, created } = await setAttendance({
      studentId: 'stu-1', date: DATE, status: 'absent',
    });
    expect({ changed, created }).toEqual({ changed: true, created: true });
    expect(record.status).toBe('absent');
    expect(await countPendingSync()).toBe(1);
  });

  it('updates the status in place, keeping the same eventId, and re-queues it', async () => {
    const original = await addAttendanceEvent({ studentId: 'stu-1', date: DATE, status: 'absent' });
    await drainQueue(); // pretend it synced

    const { record, changed, created } = await setAttendance({
      studentId: 'stu-1', date: DATE, status: 'late', recordedBy: 'teacher.a',
    });

    expect({ changed, created }).toEqual({ changed: true, created: false });
    expect(record.eventId).toBe(original.eventId);
    expect(record.status).toBe('late');

    const stored = await db.attendanceEvents.where('eventId').equals(original.eventId).first();
    expect(stored.status).toBe('late');
    expect(stored.syncedAt).toBeNull();
    expect(await countPendingSync()).toBe(1);

    const queued = await db.syncQueue.where('eventId').equals(original.eventId).first();
    expect(queued).toMatchObject({ status: 'pending', attemptCount: 0 });
  });

  it('is a no-op when the status is unchanged', async () => {
    await addAttendanceEvent({ studentId: 'stu-1', date: DATE, status: 'present' });
    const { changed } = await setAttendance({ studentId: 'stu-1', date: DATE, status: 'present' });
    expect(changed).toBe(false);
    expect(await db.auditLog.where('action').equals('attendance.updated').count()).toBe(0);
  });

  it('writes an attendance.updated audit row with from/to', async () => {
    await addAttendanceEvent({ studentId: 'stu-1', date: DATE, status: 'absent' });
    await setAttendance({ studentId: 'stu-1', date: DATE, status: 'present' });

    const audit = await db.auditLog.where('action').equals('attendance.updated').first();
    expect(JSON.parse(audit.detail)).toEqual({ from: 'absent', to: 'present' });
  });

  it('setAttendanceBatch reports created / updated / unchanged separately', async () => {
    await addAttendanceEvent({ studentId: 'stu-1', date: DATE, status: 'present' });
    const out = await setAttendanceBatch([
      { studentId: 'stu-1', date: DATE, status: 'present' }, // unchanged
      { studentId: 'stu-2', date: DATE, status: 'absent' },  // created
      { studentId: 'stu-1', date: DATE, status: 'late' },    // stu-1 again -> updated
    ]);
    expect(out.created).toEqual(['stu-2']);
    expect(out.updated).toEqual(['stu-1']);
    expect(out.unchanged).toEqual(['stu-1']);
  });

  // reopening the queue relies on there being a row to reopen; drain it first
  async function drainQueue() {
    await db.syncQueue.toCollection().modify({ status: 'synced' });
    await db.attendanceEvents.toCollection().modify({ syncedAt: new Date().toISOString() });
  }
});

describe('roster management', () => {
  const CLASS = 'class-form3b-001';

  it('adds a student with a generated stu- id and active flag', async () => {
    const s = await addStudent({ classGroupId: CLASS, fullName: '  Jane Doe  ', admissionNo: '3B/099' });
    expect(s.studentId).toMatch(/^stu-/);
    expect(s).toMatchObject({ fullName: 'Jane Doe', admissionNo: '3B/099', active: true });

    const roll = await getStudentsByClass(CLASS);
    expect(roll.map((r) => r.fullName)).toEqual(['Jane Doe']);
  });

  it('rejects an empty name', async () => {
    await expect(addStudent({ classGroupId: CLASS, fullName: '   ' })).rejects.toThrow(/name is required/);
  });

  it('hard-deletes a student with no attendance history', async () => {
    const s = await addStudent({ classGroupId: CLASS, fullName: 'No History' });
    const res = await removeStudent(s.studentId);
    expect(res).toEqual({ removed: true, softDeleted: false });
    expect(await db.students.where('studentId').equals(s.studentId).count()).toBe(0);
  });

  it('soft-deletes a student who has attendance, hiding them from the roll but keeping the row', async () => {
    const s = await addStudent({ classGroupId: CLASS, fullName: 'Has History' });
    await addAttendanceEvent({ studentId: s.studentId, date: DATE, status: 'present' });

    const res = await removeStudent(s.studentId);
    expect(res).toEqual({ removed: true, softDeleted: true });

    expect(await getStudentsByClass(CLASS)).toEqual([]);
    expect((await getStudentsByClass(CLASS, { includeInactive: true })).length).toBe(1);

    // restore
    await updateStudent(s.studentId, { active: true });
    expect((await getStudentsByClass(CLASS)).length).toBe(1);
  });

  it('updateStudent trims the name and clears a blank admission number', async () => {
    const s = await addStudent({ classGroupId: CLASS, fullName: 'Old Name', admissionNo: '1' });
    const updated = await updateStudent(s.studentId, { fullName: '  New Name  ', admissionNo: '' });
    expect(updated).toMatchObject({ fullName: 'New Name', admissionNo: null });
  });
});

describe('RFID card assignment', () => {
  const CLASS = 'class-x';

  it('normalizes a card UID (trim, strip spaces, upper-case)', () => {
    expect(normalizeCardUid('  04 a1 b2 c3 ')).toBe('04A1B2C3');
    expect(normalizeCardUid('')).toBeNull();
    expect(normalizeCardUid(null)).toBeNull();
  });

  it('stores a card on add and rejects a duplicate card on another student', async () => {
    await addStudent({ classGroupId: CLASS, fullName: 'A', cardUid: '04a1b2c3' });
    const a = (await getStudentsByClass(CLASS))[0];
    expect(a.cardUid).toBe('04A1B2C3');

    await expect(
      addStudent({ classGroupId: CLASS, fullName: 'B', cardUid: '04 A1 B2 C3' }),
    ).rejects.toThrow(/already assigned to A/);
  });

  it('setStudentCard assigns, reassigns, and clears', async () => {
    const s = await addStudent({ classGroupId: CLASS, fullName: 'C' });
    await setStudentCard(s.studentId, 'AABB');
    expect((await getStudentsByClass(CLASS))[0].cardUid).toBe('AABB');

    await setStudentCard(s.studentId, ''); // clear
    expect((await getStudentsByClass(CLASS))[0].cardUid).toBeNull();
  });
});

describe('classes', () => {
  it('createClass derives a name from grade + stream and defaults the year', async () => {
    const cls = await createClass({ grade: 'Form 3', stream: 'B' });
    expect(cls.classGroupId).toMatch(/^class-/);
    expect(cls).toMatchObject({ name: 'Form 3 B', active: true });
    expect(cls.academicYear).toBe(new Date().getFullYear());
    expect(classLabel(cls)).toBe('Form 3 B');
  });

  it('requires something to name the class', async () => {
    await expect(createClass({})).rejects.toThrow(/name/i);
  });

  it('getClasses lists newest first and hides archived', async () => {
    const a = await createClass({ name: 'Alpha' });
    await new Promise((r) => setTimeout(r, 2));
    const b = await createClass({ name: 'Beta' });

    let list = await getClasses();
    expect(list.map((c) => c.name)).toEqual(['Beta', 'Alpha']);

    await archiveClass(b.classGroupId); // empty -> hard delete
    list = await getClasses();
    expect(list.map((c) => c.name)).toEqual(['Alpha']);

    await updateClass(a.classGroupId, { name: 'Alpha Renamed' });
    expect((await getClassById(a.classGroupId)).name).toBe('Alpha Renamed');
  });

  it('archiveClass soft-deletes a class that has students', async () => {
    const cls = await createClass({ name: 'Has Students' });
    await addStudent({ classGroupId: cls.classGroupId, fullName: 'Kid' });

    const res = await archiveClass(cls.classGroupId);
    expect(res).toEqual({ archived: true, deleted: false });
    expect(await getClasses()).toEqual([]);
    expect((await getClasses({ includeArchived: true })).length).toBe(1);
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
