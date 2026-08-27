import Dexie from 'dexie';

export const db = new Dexie('SmartAttendDB');

// v1 - Phase 0 baseline. Kept verbatim so devices that already opened v1
// follow the documented upgrade path instead of silently diverging.
db.version(1).stores({
  attendanceEvents: '++id, [studentId+date], eventId, studentId, date, status, captureMethod, syncedAt, recordedBy',
  students: '++id, studentId, classGroupId, fullName, enrolledAt',
  classGroups: '++id, classGroupId, schoolId, grade, stream',
  syncQueue: '++id, eventId, status, createdAt, attemptCount',
  riskScores: '++id, studentId, totalScore, flagLevel, calculatedAt',
  auditLog: '++id, action, actorId, recordId, timestamp'
});

// v2 - Sprint 1.
// [studentId+date] becomes UNIQUE (&) so duplicate prevention is enforced by
// IndexedDB itself rather than by a read-then-write check that a second
// concurrent submit could slip past. eventId is unique too: it is the
// device-generated idempotency key the AWS sync layer deduplicates on.
// pinCredentials/authState added for the offline PIN fallback.
db.version(2).stores({
  attendanceEvents: '++id, &[studentId+date], &eventId, studentId, date, status, captureMethod, syncedAt, recordedBy',
  students: '++id, &studentId, classGroupId, fullName, enrolledAt',
  classGroups: '++id, &classGroupId, schoolId, grade, stream',
  syncQueue: '++id, &eventId, status, createdAt, attemptCount',
  riskScores: '++id, studentId, totalScore, flagLevel, calculatedAt',
  auditLog: '++id, action, actorId, recordId, timestamp',
  pinCredentials: '++id, &username',
  authState: 'key'
}).upgrade(async (tx) => {
  // A unique index cannot be built over rows that already violate it, so
  // collapse any v1 duplicates (keeping the earliest record) before v2 applies.
  const all = await tx.table('attendanceEvents').toArray();
  const seen = new Set();
  const doomed = [];
  for (const row of all.sort((a, b) => a.id - b.id)) {
    const key = `${row.studentId}|${row.date}`;
    if (seen.has(key)) doomed.push(row.id);
    else seen.add(key);
  }
  if (doomed.length > 0) {
    await tx.table('attendanceEvents').bulkDelete(doomed);
  }
});

export const ATTENDANCE_STATUSES = ['present', 'absent', 'late'];

/** Raised when a record for this student/date already exists. */
export class DuplicateAttendanceError extends Error {
  constructor(studentId, date) {
    super(`Attendance already recorded for student ${studentId} on ${date}`);
    this.name = 'DuplicateAttendanceError';
    this.studentId = studentId;
    this.date = date;
  }
}

/** Local calendar date as YYYY-MM-DD. Avoids the UTC shift toISOString() causes in EAT. */
export function todayISO(now = new Date()) {
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().split('T')[0];
}

function newId() {
  // crypto.randomUUID is unavailable on http:// origins in older Android WebViews.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Write one attendance record and enqueue it for sync, atomically.
 *
 * The event, its sync-queue entry and the audit row share a single Dexie
 * transaction: if the unique index rejects the event, the queue entry is
 * rolled back too, so the sync engine can never ship a record the local
 * database does not hold.
 *
 * @throws {DuplicateAttendanceError} if this student already has a record for this date.
 */
export async function addAttendanceEvent(event) {
  const { studentId, date, status, captureMethod = 'manual', recordedBy } = event;

  if (!studentId) throw new Error('studentId is required');
  if (!date) throw new Error('date is required');
  if (!ATTENDANCE_STATUSES.includes(status)) {
    throw new Error(`status must be one of ${ATTENDANCE_STATUSES.join(', ')} (got "${status}")`);
  }

  const eventId = newId();
  const createdAt = new Date().toISOString();

  const record = {
    eventId,
    studentId,
    date,
    status,
    captureMethod,
    recordedBy: recordedBy ?? null,
    syncedAt: null,
    createdAt
  };

  try {
    await db.transaction('rw', db.attendanceEvents, db.syncQueue, db.auditLog, async () => {
      await db.attendanceEvents.add(record);
      await db.syncQueue.add({ eventId, status: 'pending', createdAt, attemptCount: 0 });
      await db.auditLog.add({
        action: 'attendance.recorded',
        actorId: recordedBy ?? null,
        recordId: eventId,
        timestamp: createdAt
      });
    });
  } catch (err) {
    if (err?.name === 'ConstraintError' || err?.inner?.name === 'ConstraintError') {
      throw new DuplicateAttendanceError(studentId, date);
    }
    throw err;
  }

  return record;
}

/**
 * Write a whole roll call. Returns per-student outcomes rather than throwing,
 * so one already-recorded student cannot discard the rest of the class.
 */
export async function addAttendanceBatch(events) {
  const saved = [];
  const duplicates = [];
  const failed = [];

  for (const event of events) {
    try {
      saved.push(await addAttendanceEvent(event));
    } catch (err) {
      if (err instanceof DuplicateAttendanceError) duplicates.push(event.studentId);
      else failed.push({ studentId: event.studentId, reason: err.message });
    }
  }

  return { saved, duplicates, failed };
}

export async function getStudentsByClass(classGroupId) {
  const students = await db.students.where('classGroupId').equals(classGroupId).toArray();
  return students.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

/** Attendance rows for one class on one date. */
export async function getAttendanceForDate(classGroupId, date = todayISO()) {
  const students = await getStudentsByClass(classGroupId);
  const ids = new Set(students.map((s) => s.studentId));
  const records = await db.attendanceEvents.where('date').equals(date).toArray();
  return records.filter((r) => ids.has(r.studentId));
}

export async function getTodaysAttendance(classGroupId) {
  return getAttendanceForDate(classGroupId, todayISO());
}

export async function countPendingSync() {
  return db.syncQueue.where('status').equals('pending').count();
}

/** Every record for one student, oldest first - used by the Sprint 4 profile view. */
export async function getStudentHistory(studentId) {
  const rows = await db.attendanceEvents.where('studentId').equals(studentId).toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}
