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
 * Set a student's status for a date, creating the record if it does not exist
 * yet and updating it in place if it does.
 *
 * Attendance is a living value during the school day - a student marked absent
 * at 8am who walks in at 9am should become `late`, not stay wrong until
 * tomorrow. The record keeps its original `eventId` (the sync idempotency key -
 * its identity has not changed, only its content), gets an `updatedAt` stamp,
 * and is put back on the sync queue as `pending` so the correction propagates.
 * Every change writes an `attendance.updated` audit row with `{from, to}`.
 *
 * @returns {Promise<{record: object, changed: boolean, created: boolean}>}
 * @throws {Error} on an invalid studentId / date / status
 */
export async function setAttendance(event) {
  const { studentId, date, status, captureMethod = 'manual', recordedBy } = event;

  if (!studentId) throw new Error('studentId is required');
  if (!date) throw new Error('date is required');
  if (!ATTENDANCE_STATUSES.includes(status)) {
    throw new Error(`status must be one of ${ATTENDANCE_STATUSES.join(', ')} (got "${status}")`);
  }

  const existing = await db.attendanceEvents
    .where('[studentId+date]')
    .equals([studentId, date])
    .first();

  if (!existing) {
    const record = await addAttendanceEvent(event);
    return { record, changed: true, created: true };
  }

  if (existing.status === status) {
    return { record: existing, changed: false, created: false };
  }

  const updatedAt = new Date().toISOString();
  await db.transaction('rw', db.attendanceEvents, db.syncQueue, db.auditLog, async () => {
    await db.attendanceEvents.update(existing.id, {
      status,
      captureMethod,
      recordedBy: recordedBy ?? existing.recordedBy ?? null,
      updatedAt,
      syncedAt: null,
    });

    // Re-open the sync-queue row (or add one if a prior sync already retired it)
    // so drainSyncQueue picks the correction up on the next pass.
    const queued = await db.syncQueue.where('eventId').equals(existing.eventId).first();
    if (queued) {
      await db.syncQueue.update(queued.id, {
        status: 'pending', attemptCount: 0, nextAttemptAt: null, lastError: null, updatedAt,
      });
    } else {
      await db.syncQueue.add({
        eventId: existing.eventId, status: 'pending', createdAt: updatedAt, attemptCount: 0, updatedAt,
      });
    }

    await db.auditLog.add({
      action: 'attendance.updated',
      actorId: recordedBy ?? null,
      recordId: existing.eventId,
      timestamp: updatedAt,
      detail: JSON.stringify({ from: existing.status, to: status }),
    });
  });

  return {
    record: { ...existing, status, captureMethod, updatedAt, syncedAt: null },
    changed: true,
    created: false,
  };
}

/**
 * Apply a set of status changes (a re-submitted roll call, some rows new, some
 * edited). Never throws for one bad row - returns per-student outcomes.
 *
 * @returns {Promise<{saved: object[], created: string[], updated: string[], unchanged: string[], failed: {studentId, reason}[]}>}
 */
export async function setAttendanceBatch(events) {
  const saved = [];
  const created = [];
  const updated = [];
  const unchanged = [];
  const failed = [];

  for (const event of events) {
    try {
      const outcome = await setAttendance(event);
      if (!outcome.changed) unchanged.push(event.studentId);
      else {
        saved.push(outcome.record);
        (outcome.created ? created : updated).push(event.studentId);
      }
    } catch (err) {
      failed.push({ studentId: event.studentId, reason: err.message });
    }
  }

  return { saved, created, updated, unchanged, failed };
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

export async function getStudentById(studentId) {
  return db.students.where('studentId').equals(studentId).first();
}

// --------------------------------------------------------------------------- //
// Classes                                                                     //
//                                                                             //
// A device can hold several class groups (a teacher taking two streams). The  //
// first is created in the setup wizard; more are added from the class         //
// switcher. `schoolId` is a plain string here (the server owns the `schools`  //
// table); the PWA does not ask the teacher about the school in v1.            //
// --------------------------------------------------------------------------- //

export const LOCAL_SCHOOL_ID = 'school-local-001';

/** Every class on this device, newest first. Archived classes are excluded unless asked for. */
export async function getClasses({ includeArchived = false } = {}) {
  const rows = await db.classGroups.toArray();
  return rows
    .filter((c) => includeArchived || c.active !== false)
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

export async function getClassById(classGroupId) {
  return db.classGroups.where('classGroupId').equals(classGroupId).first();
}

/** Human label for a class: an explicit name, else "<grade> <stream>". */
export function classLabel(cls) {
  if (!cls) return '';
  if (cls.name) return cls.name;
  return [cls.grade, cls.stream].filter(Boolean).join(' ').trim() || 'Class';
}

/**
 * Create a class group (setup wizard / "New class").
 * @param {{grade?:string, stream?:string, academicYear?:number, name?:string, schoolId?:string}} input
 */
export async function createClass(input = {}) {
  const grade = String(input.grade ?? '').trim();
  const stream = String(input.stream ?? '').trim();
  const name = String(input.name ?? '').trim() || [grade, stream].filter(Boolean).join(' ').trim();

  if (!name) throw new Error('Give the class a name, or a grade and stream');

  const classGroupId = `class-${newId()}`;
  const now = new Date().toISOString();
  const record = {
    classGroupId,
    schoolId: input.schoolId || LOCAL_SCHOOL_ID,
    grade: grade || null,
    stream: stream || null,
    name,
    academicYear: input.academicYear ?? new Date().getFullYear(),
    active: true,
    createdAt: now,
  };

  await db.transaction('rw', db.classGroups, db.auditLog, async () => {
    await db.classGroups.add(record);
    await db.auditLog.add({
      action: 'class.created', actorId: null, recordId: classGroupId, timestamp: now,
      detail: JSON.stringify({ name, grade, stream }),
    });
  });

  return record;
}

export async function updateClass(classGroupId, patch = {}) {
  const cls = await getClassById(classGroupId);
  if (!cls) throw new Error(`Class ${classGroupId} not found`);

  const clean = {};
  if (patch.grade !== undefined) clean.grade = String(patch.grade ?? '').trim() || null;
  if (patch.stream !== undefined) clean.stream = String(patch.stream ?? '').trim() || null;
  if (patch.name !== undefined) clean.name = String(patch.name ?? '').trim() || classLabel({ ...cls, ...clean });
  if (patch.academicYear !== undefined) clean.academicYear = patch.academicYear;
  if (typeof patch.active === 'boolean') clean.active = patch.active;

  if (Object.keys(clean).length > 0) await db.classGroups.update(cls.id, clean);
  return { ...cls, ...clean };
}

/**
 * Archive (soft-delete) a class that has students or attendance history; delete
 * an empty one outright. Restore with `updateClass(id, { active: true })`.
 */
export async function archiveClass(classGroupId) {
  const cls = await getClassById(classGroupId);
  if (!cls) return { archived: false, deleted: false };

  const studentIds = (await db.students.where('classGroupId').equals(classGroupId).toArray())
    .map((s) => s.studentId);
  let historyCount = 0;
  for (const id of studentIds) {
    historyCount += await db.attendanceEvents.where('studentId').equals(id).count();
  }
  const hasData = studentIds.length > 0 || historyCount > 0;
  const now = new Date().toISOString();

  await db.transaction('rw', db.classGroups, db.auditLog, async () => {
    if (hasData) await db.classGroups.update(cls.id, { active: false, archivedAt: now });
    else await db.classGroups.delete(cls.id);
    await db.auditLog.add({
      action: hasData ? 'class.archived' : 'class.deleted',
      actorId: null, recordId: classGroupId, timestamp: now,
      detail: JSON.stringify({ students: studentIds.length, historyCount }),
    });
  });

  return { archived: hasData, deleted: !hasData };
}

/**
 * The class roll, A-Z. Removed students (`active === false`) are hidden from
 * every screen by default; the roster manager passes `includeInactive` to show
 * and restore them. `active` is undefined on students seeded before this field
 * existed, so the check is `!== false`, not `=== true`.
 */
export async function getStudentsByClass(classGroupId, { includeInactive = false } = {}) {
  const students = await db.students.where('classGroupId').equals(classGroupId).toArray();
  return students
    .filter((s) => includeInactive || s.active !== false)
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}

// --------------------------------------------------------------------------- //
// RFID cards                                                                  //
//                                                                             //
// The workflow is: enrol the student -> the system issues them a random card  //
// number -> that number is printed/encoded onto a physical card they tap at   //
// the gate. Teachers never type a card UID; they can reissue one (lost card). //
// Format: 8 upper-case hex characters, e.g. "A1B2C3D4" - matches the UID      //
// shape the Tier 2 RFID simulation already uses.                              //
// --------------------------------------------------------------------------- //

/** Normalise an RFID card UID: trim, strip spaces, upper-case. Empty -> null. */
export function normalizeCardUid(raw) {
  const v = String(raw ?? '').replace(/\s+/g, '').toUpperCase();
  return v || null;
}

/** The student currently holding this card UID, if any. */
export async function getStudentByCard(cardUid) {
  const uid = normalizeCardUid(cardUid);
  if (!uid) return null;
  return (await db.students.toArray()).find((s) => normalizeCardUid(s.cardUid) === uid) ?? null;
}

function randomCardUid() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** A fresh card UID guaranteed not to collide with any student on this device. */
export async function generateCardUid() {
  const taken = new Set(
    (await db.students.toArray()).map((s) => normalizeCardUid(s.cardUid)).filter(Boolean),
  );
  let uid = randomCardUid();
  while (taken.has(uid)) uid = randomCardUid();
  return uid;
}

/**
 * Enrol a student in a class. The system issues them a random RFID card number
 * straight away (pass `cardUid` only to import an existing one). The generated
 * `studentId` uses a `stu-` prefix to match the seeded IDs.
 */
export async function addStudent({ classGroupId, fullName, admissionNo, cardUid }) {
  if (!classGroupId) throw new Error('classGroupId is required');
  const name = String(fullName ?? '').trim();
  if (!name) throw new Error('Student name is required');

  let uid = normalizeCardUid(cardUid);
  if (uid) {
    const holder = await getStudentByCard(uid);
    if (holder) throw new Error(`Card ${uid} is already assigned to ${holder.fullName}`);
  } else {
    uid = await generateCardUid();
  }

  const studentId = `stu-${newId()}`;
  const now = new Date().toISOString();
  const record = {
    studentId,
    classGroupId,
    fullName: name,
    admissionNo: String(admissionNo ?? '').trim() || null,
    cardUid: uid,
    cardIssuedAt: now,
    enrolledAt: todayISO(),
    active: true,
  };

  await db.transaction('rw', db.students, db.auditLog, async () => {
    await db.students.add(record);
    await db.auditLog.add({
      action: 'student.enrolled', actorId: null, recordId: studentId, timestamp: now,
      detail: JSON.stringify({ fullName: name, classGroupId, cardUid: uid }),
    });
  });

  return record;
}

/**
 * Issue a student a fresh random card number - use when a card is lost or
 * damaged and a replacement must be printed. Returns the new UID.
 */
export async function issueCard(studentId) {
  const student = await db.students.where('studentId').equals(studentId).first();
  if (!student) throw new Error(`Student ${studentId} not found`);

  const uid = await generateCardUid();
  const now = new Date().toISOString();
  await db.transaction('rw', db.students, db.auditLog, async () => {
    await db.students.update(student.id, { cardUid: uid, cardIssuedAt: now });
    await db.auditLog.add({
      action: 'student.card_issued', actorId: null, recordId: studentId, timestamp: now,
      detail: JSON.stringify({ cardUid: uid, replaces: student.cardUid ?? null }),
    });
  });
  return { ...student, cardUid: uid, cardIssuedAt: now };
}

/**
 * Set or clear a student's card UID by hand (importing a pre-printed batch, or
 * clearing a card with a falsy value). Enforces one card per student device-wide.
 */
export async function setStudentCard(studentId, cardUid) {
  const student = await db.students.where('studentId').equals(studentId).first();
  if (!student) throw new Error(`Student ${studentId} not found`);

  const uid = normalizeCardUid(cardUid);
  if (uid) {
    const holder = await getStudentByCard(uid);
    if (holder && holder.studentId !== studentId) {
      throw new Error(`Card ${uid} is already assigned to ${holder.fullName}`);
    }
  }

  await db.transaction('rw', db.students, db.auditLog, async () => {
    await db.students.update(student.id, { cardUid: uid, cardIssuedAt: uid ? new Date().toISOString() : null });
    await db.auditLog.add({
      action: uid ? 'student.card_assigned' : 'student.card_cleared',
      actorId: null, recordId: studentId, timestamp: new Date().toISOString(),
      detail: JSON.stringify({ cardUid: uid }),
    });
  });

  return { ...student, cardUid: uid };
}

/** Edit a student's name or admission number. */
export async function updateStudent(studentId, patch = {}) {
  const student = await db.students.where('studentId').equals(studentId).first();
  if (!student) throw new Error(`Student ${studentId} not found`);

  const clean = {};
  if (patch.fullName != null) {
    const name = String(patch.fullName).trim();
    if (!name) throw new Error('Student name is required');
    clean.fullName = name;
  }
  if (patch.admissionNo !== undefined) {
    clean.admissionNo = String(patch.admissionNo ?? '').trim() || null;
  }
  if (typeof patch.active === 'boolean') clean.active = patch.active;

  if (Object.keys(clean).length > 0) await db.students.update(student.id, clean);
  return { ...student, ...clean };
}

/**
 * Remove a student from a class. A student who already has attendance history is
 * deactivated (soft delete) so the heatmap and past reports stay intact; one
 * with no records is deleted outright. Restore a soft-deleted student with
 * `updateStudent(id, { active: true })`.
 *
 * @returns {Promise<{removed: boolean, softDeleted: boolean}>}
 */
export async function removeStudent(studentId) {
  const student = await db.students.where('studentId').equals(studentId).first();
  if (!student) return { removed: false, softDeleted: false };

  const historyCount = await db.attendanceEvents.where('studentId').equals(studentId).count();
  const soft = historyCount > 0;
  const now = new Date().toISOString();

  await db.transaction('rw', db.students, db.auditLog, async () => {
    if (soft) await db.students.update(student.id, { active: false, removedAt: now });
    else await db.students.delete(student.id);
    await db.auditLog.add({
      action: soft ? 'student.deactivated' : 'student.deleted',
      actorId: null, recordId: studentId, timestamp: now,
      detail: JSON.stringify({ fullName: student.fullName, historyCount }),
    });
  });

  return { removed: true, softDeleted: soft };
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

/**
 * Records not yet confirmed by the server: `pending` (never sent) plus `failed`
 * (sent, will retry on backoff). Both are "awaiting sync" from the teacher's
 * point of view, so the badge counts them together.
 */
export async function countPendingSync() {
  return db.syncQueue.where('status').anyOf('pending', 'failed').count();
}

/** Every record for one student, oldest first - used by the Sprint 4 profile view. */
export async function getStudentHistory(studentId) {
  const rows = await db.attendanceEvents.where('studentId').equals(studentId).toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Every attendance record for a class since `sinceISO` (inclusive), oldest
 * first. Backs the Heatmap grid and the Alerts / Profile risk scoring, which
 * need weeks of history rather than a single day.
 */
export async function getClassHistory(classGroupId, sinceISO) {
  const students = await getStudentsByClass(classGroupId);
  const ids = new Set(students.map((s) => s.studentId));
  const rows = await db.attendanceEvents
    .where('date')
    .aboveOrEqual(sinceISO)
    .toArray();
  return rows
    .filter((r) => ids.has(r.studentId))
    .sort((a, b) => a.date.localeCompare(b.date));
}
