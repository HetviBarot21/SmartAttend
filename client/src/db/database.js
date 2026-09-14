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

// v3 - central admin / multi-teacher support.
// rosterSyncQueue: roster writes (schools/classes/students/cards) waiting to
//   reach the server's shared roster tables - the same offline-first pattern
//   as syncQueue, but for roster rather than attendance (see
//   services/rosterSyncService.js). No new indexes are needed on existing
//   tables, so no .upgrade() migration is required for this bump.
// followUps: local log of contact attempts for a flagged student, mirrored to
//   the server via rosterSyncQueue so the admin dashboard sees the same log.
db.version(3).stores({
  rosterSyncQueue: '++id, status, createdAt, attemptCount',
  followUps: '++id, &followUpId, studentId, createdAt',
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

/** UUID v4. Exported for callers (e.g. seedData.js) that need a sync-schema-valid eventId. */
export function newId() {
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

/**
 * Queue a roster write to reach the server's shared schools/class_groups/
 * students tables (server/src/routes/roster.js) - the offline-first
 * counterpart of `addAttendanceEvent`'s `syncQueue` row, drained by
 * `services/rosterSyncService.js` on reconnect. Call *inside* the same Dexie
 * transaction as the local write it describes (Dexie transactions are
 * ambient - no explicit tx handle needed), so the two can never diverge.
 */
function queueRosterPush({ method = 'POST', path, body }) {
  return db.rosterSyncQueue.add({
    method, path, body, status: 'pending', createdAt: new Date().toISOString(), attemptCount: 0,
  });
}

/**
 * Every class belonging to the signed-in account on this device, newest
 * first - plus the shared demo class (`demo: true`), which anyone can load to
 * explore the app. Archived classes are excluded unless asked for.
 *
 * A device can be shared by several teachers signing in and out in turn (a
 * staff room tablet, say), so classes are scoped to `ownerUsername`, not just
 * "whatever is in this device's IndexedDB" - otherwise the next person to
 * sign in would land straight in the previous teacher's roster instead of
 * setting up their own.
 *
 * Classes created before this scoping existed have no `ownerUsername`; the
 * first account to call this after upgrading claims them (rather than the
 * classes silently vanishing for everyone), and they stay that account's
 * from then on.
 *
 * @param {{includeArchived?: boolean, ownerUsername?: string}} [opts]
 */
export async function getClasses({ includeArchived = false, ownerUsername } = {}) {
  if (ownerUsername) {
    const orphaned = await db.classGroups.filter((c) => !c.demo && !c.ownerUsername).toArray();
    for (const c of orphaned) {
      await db.classGroups.update(c.id, { ownerUsername });
    }
  }

  const rows = await db.classGroups.toArray();
  return rows
    .filter((c) => includeArchived || c.active !== false)
    .filter((c) => !ownerUsername || c.demo || c.ownerUsername === ownerUsername)
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
 * @param {{grade?:string, stream?:string, academicYear?:number, name?:string, schoolId?:string,
 *           schoolName?:string, teacherName?:string, ownerUsername?:string}} input
 */
export async function createClass(input = {}) {
  const grade = String(input.grade ?? '').trim();
  const stream = String(input.stream ?? '').trim();
  const name = String(input.name ?? '').trim() || [grade, stream].filter(Boolean).join(' ').trim();

  if (!name) throw new Error('Give the class a name, or a grade and stream');

  const classGroupId = `class-${newId()}`;
  const now = new Date().toISOString();
  const schoolId = input.schoolId || LOCAL_SCHOOL_ID;
  const academicYear = input.academicYear ?? new Date().getFullYear();
  const teacherName = input.teacherName || null;
  const record = {
    classGroupId,
    schoolId,
    grade: grade || null,
    stream: stream || null,
    name,
    academicYear,
    teacherName,
    ownerUsername: input.ownerUsername || null,
    active: true,
    createdAt: now,
  };

  await db.transaction('rw', db.classGroups, db.auditLog, db.rosterSyncQueue, async () => {
    await db.classGroups.add(record);
    await db.auditLog.add({
      action: 'class.created', actorId: null, recordId: classGroupId, timestamp: now,
      detail: JSON.stringify({ name, grade, stream }),
    });
    // The class push needs the school row to exist first; queued in the same
    // order, drained strictly in order, so this dependency is respected
    // without any explicit "has the school synced yet" check.
    await queueRosterPush({ path: '/api/roster/schools', body: { schoolId, name: input.schoolName || 'My School' } });
    await queueRosterPush({
      path: '/api/roster/classes',
      body: { classGroupId, schoolId, grade: grade || 'Class', stream: stream || null, academicYear, teacherName },
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
  if (patch.teacherName !== undefined) clean.teacherName = patch.teacherName || null;
  if (typeof patch.active === 'boolean') clean.active = patch.active;

  if (Object.keys(clean).length > 0) {
    await db.transaction('rw', db.classGroups, db.rosterSyncQueue, async () => {
      await db.classGroups.update(cls.id, clean);
      // 'name' and 'active' are client-only concepts (the server's class_groups
      // has no such columns) - only push the fields it actually stores.
      const { grade, stream, academicYear, teacherName } = clean;
      if (grade !== undefined || stream !== undefined || academicYear !== undefined || teacherName !== undefined) {
        await queueRosterPush({ method: 'PATCH', path: `/api/roster/classes/${classGroupId}`, body: { grade, stream, academicYear, teacherName } });
      }
    });
  }
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
export async function addStudent({ classGroupId, fullName, admissionNo, cardUid, guardianPhone, guardianEmail }) {
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
    guardianPhone: String(guardianPhone ?? '').trim() || null,
    guardianEmail: String(guardianEmail ?? '').trim() || null,
    cardUid: uid,
    cardIssuedAt: now,
    enrolledAt: todayISO(),
    active: true,
  };

  await db.transaction('rw', db.students, db.auditLog, db.rosterSyncQueue, async () => {
    await db.students.add(record);
    await db.auditLog.add({
      action: 'student.enrolled', actorId: null, recordId: studentId, timestamp: now,
      detail: JSON.stringify({ fullName: name, classGroupId, cardUid: uid }),
    });
    await queueRosterPush({
      path: '/api/roster/students',
      body: {
        studentId, classGroupId, fullName: name, admissionNo: record.admissionNo,
        guardianPhone: record.guardianPhone, guardianEmail: record.guardianEmail, enrolledAt: record.enrolledAt,
      },
    });
    await queueRosterPush({ path: `/api/roster/students/${studentId}/card`, body: { cardUid: uid } });
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
  await db.transaction('rw', db.students, db.auditLog, db.rosterSyncQueue, async () => {
    await db.students.update(student.id, { cardUid: uid, cardIssuedAt: now });
    await db.auditLog.add({
      action: 'student.card_issued', actorId: null, recordId: studentId, timestamp: now,
      detail: JSON.stringify({ cardUid: uid, replaces: student.cardUid ?? null }),
    });
    await queueRosterPush({ path: `/api/roster/students/${studentId}/card`, body: { cardUid: uid } });
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

  await db.transaction('rw', db.students, db.auditLog, db.rosterSyncQueue, async () => {
    await db.students.update(student.id, { cardUid: uid, cardIssuedAt: uid ? new Date().toISOString() : null });
    await db.auditLog.add({
      action: uid ? 'student.card_assigned' : 'student.card_cleared',
      actorId: null, recordId: studentId, timestamp: new Date().toISOString(),
      detail: JSON.stringify({ cardUid: uid }),
    });
    // No "clear a card" endpoint server-side yet - only push a real assignment.
    if (uid) await queueRosterPush({ path: `/api/roster/students/${studentId}/card`, body: { cardUid: uid } });
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
  if (patch.guardianPhone !== undefined) {
    clean.guardianPhone = String(patch.guardianPhone ?? '').trim() || null;
  }
  if (patch.guardianEmail !== undefined) {
    clean.guardianEmail = String(patch.guardianEmail ?? '').trim() || null;
  }
  if (typeof patch.active === 'boolean') clean.active = patch.active;

  if (Object.keys(clean).length > 0) {
    await db.transaction('rw', db.students, db.rosterSyncQueue, async () => {
      await db.students.update(student.id, clean);
      await queueRosterPush({ method: 'PATCH', path: `/api/roster/students/${studentId}`, body: clean });
    });
  }
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

  await db.transaction('rw', db.students, db.auditLog, db.rosterSyncQueue, async () => {
    if (soft) await db.students.update(student.id, { active: false, removedAt: now });
    else await db.students.delete(student.id);
    await db.auditLog.add({
      action: soft ? 'student.deactivated' : 'student.deleted',
      actorId: null, recordId: studentId, timestamp: now,
      detail: JSON.stringify({ fullName: student.fullName, historyCount }),
    });
    // Deactivate server-side either way - harmless no-op if the row was never
    // pushed (e.g. it was created and removed again before reconnecting).
    await queueRosterPush({ method: 'PATCH', path: `/api/roster/students/${studentId}`, body: { active: false } });
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

/** Roster writes not yet confirmed by the server - mirrors countPendingSync(). */
export async function countPendingRosterSync() {
  return db.rosterSyncQueue.where('status').anyOf('pending', 'failed').count();
}

// --------------------------------------------------------------------------- //
// Follow-ups                                                                  //
//                                                                             //
// One row per time a teacher/admin reaches out about a flagged student. There //
// is no "resolved" ticket state (see server/src/db/schema.sql's follow_ups    //
// comment) - a fresh flag after a gap just gets a fresh row. Mirrored to the  //
// server via rosterSyncQueue so an admin's cross-class view and the teacher's //
// own device agree on who has been contacted.                                //
// --------------------------------------------------------------------------- //

const FOLLOW_UP_METHODS = ['parent_call', 'sms', 'home_visit', 'meeting', 'other'];

/** Log a follow-up for a flagged student. `flag` is the risk flag at the time ('amber'|'red'). */
export async function addFollowUp({ studentId, flag, method, note, actorId }) {
  if (!studentId) throw new Error('studentId is required');
  if (!['amber', 'red'].includes(flag)) throw new Error(`flag must be amber or red (got "${flag}")`);
  if (!FOLLOW_UP_METHODS.includes(method)) throw new Error(`method must be one of ${FOLLOW_UP_METHODS.join(', ')}`);

  const now = new Date().toISOString();
  const record = {
    followUpId: `fu-${newId()}`,
    studentId,
    flag,
    method,
    note: String(note ?? '').trim() || null,
    actorId: actorId ?? null,
    createdAt: now,
  };

  await db.transaction('rw', db.followUps, db.auditLog, db.rosterSyncQueue, async () => {
    await db.followUps.add(record);
    await db.auditLog.add({
      action: 'followup.logged', actorId: actorId ?? null, recordId: studentId, timestamp: now,
      detail: JSON.stringify({ flag, method }),
    });
    await queueRosterPush({
      path: `/api/admin/students/${studentId}/follow-ups`,
      body: { flag, method, note: record.note, actor: actorId ?? null },
    });
  });

  return record;
}

/** A student's follow-up log, newest first. */
export async function getFollowUpsForStudent(studentId) {
  const rows = await db.followUps.where('studentId').equals(studentId).toArray();
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export const FOLLOW_UP_FRESH_DAYS = 14;

/**
 * For a set of (typically flagged) students: when each was last followed up,
 * and which have gone `freshDays` or more without one (or never had one at
 * all). Drives the "needs follow-up" badge on Alerts cards and the follow-up
 * pill on the profile.
 * @returns {Promise<{lastAt: Map<string,string>, needsFollowUp: Set<string>}>}
 */
export async function getFollowUpSummary(studentIds, freshDays = FOLLOW_UP_FRESH_DAYS) {
  if (studentIds.length === 0) return { lastAt: new Map(), needsFollowUp: new Set() };
  const cutoff = new Date(Date.now() - freshDays * 86_400_000).toISOString();
  const rows = await db.followUps.where('studentId').anyOf(studentIds).toArray();
  const lastAt = new Map();
  for (const r of rows) {
    const prev = lastAt.get(r.studentId);
    if (!prev || r.createdAt > prev) lastAt.set(r.studentId, r.createdAt);
  }
  const needsFollowUp = new Set();
  for (const id of studentIds) {
    const last = lastAt.get(id);
    if (!last || last < cutoff) needsFollowUp.add(id);
  }
  return { lastAt, needsFollowUp };
}
