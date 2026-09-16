import { randomUUID } from 'node:crypto';
import { assessStudent, FOLLOW_UP_FRESH_DAYS } from '../lib/riskModel.js';

/** Local calendar date as YYYY-MM-DD. Matches the client's todayISO(). */
export function todayISO(now = new Date()) {
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().split('T')[0];
}

/** Raised when a student already has an attendance record for a date. */
export class DuplicateAttendanceError extends Error {
  constructor(studentId, date) {
    super(`Attendance already recorded for ${studentId} on ${date}`);
    this.name = 'DuplicateAttendanceError';
    this.studentId = studentId;
    this.date = date;
  }
}

const isUniqueViolation = (err) =>
  err && (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY');

/** Resolve an RFID card UID to its active student. Returns null if unknown. */
export function findStudentByCardUid(db, cardUid) {
  return db
    .prepare(
      `SELECT s.student_id, s.full_name, s.admission_no, s.class_group_id, c.card_uid
         FROM rfid_cards c
         JOIN students s ON s.student_id = c.student_id
        WHERE c.card_uid = ? AND c.active = 1`
    )
    .get(cardUid) ?? null;
}

/**
 * Write one attendance record, its sync-queue entry and an audit row in a
 * single transaction - exactly the client's atomicity guarantee: if the unique
 * index rejects the event, the queue entry rolls back with it, so the sync
 * layer can never ship a record the database does not hold.
 *
 * @throws {DuplicateAttendanceError}
 */
export function recordAttendance(db, event) {
  const {
    studentId,
    date = todayISO(),
    status = 'present',
    captureMethod,
    verified = 0,
    recordedBy = null,
    source = 'simulation',
    eventId = randomUUID(),
  } = event;

  if (!studentId) throw new Error('studentId is required');
  if (!['present', 'absent', 'late'].includes(status)) throw new Error(`bad status: ${status}`);
  if (!['manual', 'rfid', 'fingerprint', 'import'].includes(captureMethod)) {
    throw new Error(`bad captureMethod: ${captureMethod}`);
  }

  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO attendance_events
           (event_id, student_id, date, status, capture_method, verified, recorded_by, source)
         VALUES (@eventId, @studentId, @date, @status, @captureMethod, @verified, @recordedBy, @source)`
      )
      .run({ eventId, studentId, date, status, captureMethod, verified: verified ? 1 : 0, recordedBy, source });

    // Snapshot the record in the shape the sync Lambda expects
    // (attendanceSync.schema.js). createdAt must be an RFC3339 timestamp, so it
    // is generated here rather than read back from the row's `datetime('now')`.
    const payload = JSON.stringify({
      eventId,
      studentId,
      date,
      status,
      captureMethod,
      recordedBy,
      createdAt: new Date().toISOString(),
    });
    db.prepare(`INSERT INTO sync_queue (event_id, payload, status) VALUES (?, ?, 'pending')`).run(
      eventId,
      payload
    );

    db.prepare(
      `INSERT INTO audit_log (action, actor_id, record_id, detail)
       VALUES ('attendance.recorded', @recordedBy, @eventId, @detail)`
    ).run({
      recordedBy,
      eventId,
      detail: JSON.stringify({ studentId, date, status, captureMethod, verified: !!verified, source }),
    });

    return { id: info.lastInsertRowid, eventId, studentId, date, status, captureMethod, verified: !!verified, source };
  });

  try {
    return tx();
  } catch (err) {
    if (isUniqueViolation(err)) throw new DuplicateAttendanceError(studentId, date);
    throw err;
  }
}

export function logFingerprintChallenge(db, { studentId, cardUid, eventId = null, result, successRate }) {
  const info = db
    .prepare(
      `INSERT INTO fingerprint_challenges (student_id, card_uid, event_id, result, success_rate)
       VALUES (@studentId, @cardUid, @eventId, @result, @successRate)`
    )
    .run({ studentId, cardUid, eventId, result, successRate });
  return { id: info.lastInsertRowid, studentId, cardUid, eventId, result, successRate };
}

export function logAudit(db, { action, actorId = null, recordId = null, detail = null }) {
  db.prepare(
    `INSERT INTO audit_log (action, actor_id, record_id, detail) VALUES (?, ?, ?, ?)`
  ).run(action, actorId, recordId, detail == null ? null : JSON.stringify(detail));
}

export function countPendingSync(db) {
  return db.prepare(`SELECT COUNT(*) AS n FROM sync_queue WHERE status = 'pending'`).get().n;
}

export function getAttendanceForDate(db, date = todayISO()) {
  return db
    .prepare(
      `SELECT a.*, s.full_name, s.admission_no
         FROM attendance_events a
         JOIN students s ON s.student_id = a.student_id
        WHERE a.date = ?
        ORDER BY a.created_at`
    )
    .all(date);
}

export function getRecentChallenges(db, limit = 50) {
  return db
    .prepare(
      `SELECT fc.*, s.full_name
         FROM fingerprint_challenges fc
         JOIN students s ON s.student_id = fc.student_id
        ORDER BY fc.challenged_at DESC, fc.id DESC
        LIMIT ?`
    )
    .all(limit);
}

export function getStats(db, date = todayISO()) {
  const byMethod = db
    .prepare(
      `SELECT capture_method, COUNT(*) AS n FROM attendance_events WHERE date = ? GROUP BY capture_method`
    )
    .all(date);
  const challenges = db
    .prepare(
      `SELECT result, COUNT(*) AS n FROM fingerprint_challenges
        WHERE date(challenged_at) = ? GROUP BY result`
    )
    .all(date);

  const method = Object.fromEntries(byMethod.map((r) => [r.capture_method, r.n]));
  const challenge = Object.fromEntries(challenges.map((r) => [r.result, r.n]));
  const totalAttendance = Object.values(method).reduce((a, b) => a + b, 0);
  const totalChallenges = Object.values(challenge).reduce((a, b) => a + b, 0);

  return {
    date,
    attendanceByMethod: method,
    totalAttendance,
    challenges: { ...challenge, total: totalChallenges },
    pendingSync: countPendingSync(db),
  };
}

// --------------------------------------------------------------------------- //
// Roster - upserts pushed from the PWA (client/src/services/rosterSyncService)  //
//                                                                               //
// The server's schools/class_groups/students tables were, until now, only fed  //
// by the RFID simulation demo roster. A class or student created in the PWA    //
// has no server-side row at all, so its attendance sync fails with             //
// `unknown_student` and it is invisible to the admin endpoints below. These    //
// upserts are how a teacher's device roster becomes the shared source of       //
// truth an admin can report on. All idempotent - same INSERT..ON CONFLICT      //
// idiom as db/seed.js so a re-push (retry after a dropped connection) repairs  //
// rather than throws.                                                          //
// --------------------------------------------------------------------------- //

export function upsertSchool(db, { schoolId, name, county = null }) {
  db.prepare(
    `INSERT INTO schools (school_id, name, county) VALUES (@schoolId, @name, @county)
     ON CONFLICT(school_id) DO UPDATE SET name = excluded.name, county = excluded.county`
  ).run({ schoolId, name, county });
  return { schoolId, name, county };
}

// --------------------------------------------------------------------------- //
// System admin - platform-wide school list + activate/deactivate.             //
// No enforcement yet: an 'inactive' school's teachers/admins can still sign   //
// in, sync and view data as normal. This is display + a status flag only,    //
// until real authentication (Sprint 2) can gate access on it.                 //
// --------------------------------------------------------------------------- //

export function getAllSchools(db) {
  return db
    .prepare(
      `SELECT s.school_id AS schoolId, s.name, s.county, s.status, s.created_at AS createdAt,
              (SELECT COUNT(*) FROM class_groups c WHERE c.school_id = s.school_id) AS classCount,
              (SELECT COUNT(*) FROM students st
                 JOIN class_groups c ON c.class_group_id = st.class_group_id
                WHERE c.school_id = s.school_id AND st.active = 1) AS studentCount
         FROM schools s
        ORDER BY s.name`
    )
    .all();
}

export function setSchoolStatus(db, schoolId, status) {
  if (status !== 'active' && status !== 'inactive') {
    throw new Error(`invalid status: ${status}`);
  }
  const info = db.prepare(`UPDATE schools SET status = ? WHERE school_id = ?`).run(status, schoolId);
  if (info.changes === 0) return null;
  logAudit(db, { action: 'school.status_changed', actorId: null, recordId: schoolId, detail: { status } });
  return db
    .prepare(`SELECT school_id AS schoolId, name, county, status, created_at AS createdAt FROM schools WHERE school_id = ?`)
    .get(schoolId);
}

export function upsertClassGroup(db, { classGroupId, schoolId, grade, stream = null, academicYear, teacherName = null }) {
  db.prepare(
    `INSERT INTO class_groups (class_group_id, school_id, grade, stream, academic_year, teacher_name)
     VALUES (@classGroupId, @schoolId, @grade, @stream, @academicYear, @teacherName)
     ON CONFLICT(class_group_id) DO UPDATE SET
       school_id = excluded.school_id, grade = excluded.grade, stream = excluded.stream,
       academic_year = excluded.academic_year, teacher_name = excluded.teacher_name`
  ).run({ classGroupId, schoolId, grade: grade || 'Class', stream, academicYear: academicYear || new Date().getFullYear(), teacherName });
  return { classGroupId, schoolId, grade, stream, academicYear, teacherName };
}

export function patchClassGroup(db, classGroupId, patch = {}) {
  const fields = [];
  const params = { classGroupId };
  for (const [col, key] of [['grade', 'grade'], ['stream', 'stream'], ['academic_year', 'academicYear'], ['teacher_name', 'teacherName']]) {
    if (patch[key] !== undefined) {
      fields.push(`${col} = @${key}`);
      params[key] = patch[key];
    }
  }
  if (fields.length === 0) return;
  db.prepare(`UPDATE class_groups SET ${fields.join(', ')} WHERE class_group_id = @classGroupId`).run(params);
}

export function upsertStudent(db, { studentId, classGroupId, admissionNo = null, fullName, guardianPhone = null, guardianEmail = null, enrolledAt, active = true }) {
  db.prepare(
    `INSERT INTO students (student_id, class_group_id, admission_no, full_name, guardian_phone, guardian_email, enrolled_at, active)
     VALUES (@studentId, @classGroupId, @admissionNo, @fullName, @guardianPhone, @guardianEmail, @enrolledAt, @active)
     ON CONFLICT(student_id) DO UPDATE SET
       class_group_id = excluded.class_group_id, admission_no = excluded.admission_no,
       full_name = excluded.full_name, guardian_phone = excluded.guardian_phone,
       guardian_email = excluded.guardian_email, active = excluded.active`
  ).run({
    studentId, classGroupId, admissionNo: admissionNo || '', fullName, guardianPhone, guardianEmail,
    enrolledAt: enrolledAt || todayISO(), active: active ? 1 : 0,
  });
  return { studentId, classGroupId, admissionNo, fullName, guardianPhone, guardianEmail, enrolledAt, active };
}

export function patchStudent(db, studentId, patch = {}) {
  const fields = [];
  const params = { studentId };
  if (patch.fullName !== undefined) { fields.push('full_name = @fullName'); params.fullName = patch.fullName; }
  if (patch.admissionNo !== undefined) { fields.push('admission_no = @admissionNo'); params.admissionNo = patch.admissionNo || ''; }
  if (patch.guardianPhone !== undefined) { fields.push('guardian_phone = @guardianPhone'); params.guardianPhone = patch.guardianPhone || null; }
  if (patch.guardianEmail !== undefined) { fields.push('guardian_email = @guardianEmail'); params.guardianEmail = patch.guardianEmail || null; }
  if (patch.active !== undefined) { fields.push('active = @active'); params.active = patch.active ? 1 : 0; }
  if (fields.length === 0) return;
  db.prepare(`UPDATE students SET ${fields.join(', ')} WHERE student_id = @studentId`).run(params);
}

/** One active card per student - deactivate any other active card first (mirrors the partial unique index). */
export function upsertCard(db, { cardUid, studentId }) {
  const tx = db.transaction(() => {
    db.prepare(`UPDATE rfid_cards SET active = 0 WHERE student_id = ? AND active = 1 AND card_uid != ?`).run(studentId, cardUid);
    db.prepare(
      `INSERT INTO rfid_cards (card_uid, student_id, active) VALUES (?, ?, 1)
       ON CONFLICT(card_uid) DO UPDATE SET student_id = excluded.student_id, active = 1`
    ).run(cardUid, studentId);
  });
  tx();
  return { cardUid, studentId };
}

// --------------------------------------------------------------------------- //
// Admin reporting - cross-class / cross-teacher views over one school          //
// --------------------------------------------------------------------------- //

export function getClassesForSchool(db, schoolId) {
  return db
    .prepare(
      `SELECT c.class_group_id AS classGroupId, c.grade, c.stream, c.academic_year AS academicYear,
              c.teacher_name AS teacherName,
              (SELECT COUNT(*) FROM students s WHERE s.class_group_id = c.class_group_id AND s.active = 1) AS studentCount
         FROM class_groups c
        WHERE c.school_id = ?
        ORDER BY c.grade, c.stream`
    )
    .all(schoolId);
}

export function getClassGroup(db, classGroupId) {
  return db
    .prepare(
      `SELECT class_group_id AS classGroupId, school_id AS schoolId, grade, stream,
              academic_year AS academicYear, teacher_name AS teacherName
         FROM class_groups WHERE class_group_id = ?`
    )
    .get(classGroupId);
}

export function getStudentsForClass(db, classGroupId, { includeInactive = false } = {}) {
  const clause = includeInactive ? '' : 'AND active = 1';
  return db
    .prepare(
      `SELECT student_id AS studentId, class_group_id AS classGroupId, admission_no AS admissionNo,
              full_name AS fullName, guardian_phone AS guardianPhone, guardian_email AS guardianEmail,
              enrolled_at AS enrolledAt, active
         FROM students WHERE class_group_id = ? ${clause} ORDER BY full_name`
    )
    .all(classGroupId);
}

/** Attendance rows for a set of students since a date, shaped for the risk model. */
function historyByStudent(db, studentIds, sinceISO) {
  const byStudent = new Map(studentIds.map((id) => [id, []]));
  if (studentIds.length === 0) return byStudent;
  const placeholders = studentIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT student_id, date, status FROM attendance_events WHERE student_id IN (${placeholders}) AND date >= ? ORDER BY date`)
    .all(...studentIds, sinceISO);
  for (const r of rows) byStudent.get(r.student_id)?.push({ date: r.date, status: r.status });
  return byStudent;
}

function daysAgoISO(n) {
  const dt = new Date();
  dt.setDate(dt.getDate() - n);
  return todayISO(dt);
}

/** Most recent follow_ups row per student, for the "needs follow-up" freshness check. */
function latestFollowUpByStudent(db, studentIds) {
  const out = new Map();
  if (studentIds.length === 0) return out;
  const placeholders = studentIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT student_id, MAX(created_at) AS lastAt FROM follow_ups WHERE student_id IN (${placeholders}) GROUP BY student_id`
    )
    .all(...studentIds);
  for (const r of rows) out.set(r.student_id, r.lastAt);
  return out;
}

/**
 * Every active, assessable student in a school with a non-green flag, richest
 * first. `needsFollowUp` is true when there is no follow_ups row in the last
 * FOLLOW_UP_FRESH_DAYS - i.e. never contacted, or flagged again since the last
 * contact went stale.
 */
export function getFlaggedStudents(db, schoolId) {
  const students = db
    .prepare(
      `SELECT s.student_id AS studentId, s.full_name AS fullName, s.class_group_id AS classGroupId,
              s.guardian_phone AS guardianPhone, s.guardian_email AS guardianEmail,
              c.grade, c.stream, c.teacher_name AS teacherName
         FROM students s
         JOIN class_groups c ON c.class_group_id = s.class_group_id
        WHERE c.school_id = ? AND s.active = 1`
    )
    .all(schoolId);

  const ids = students.map((s) => s.studentId);
  const history = historyByStudent(db, ids, daysAgoISO(63));
  const lastFollowUp = latestFollowUpByStudent(db, ids);
  const freshCutoff = daysAgoISO(FOLLOW_UP_FRESH_DAYS);

  return students
    .map((s) => {
      const assessment = assessStudent(history.get(s.studentId) ?? []);
      if (!assessment || assessment.flag === 'green') return null;
      const lastAt = lastFollowUp.get(s.studentId) ?? null;
      const needsFollowUp = !lastAt || lastAt.slice(0, 10) < freshCutoff;
      return {
        studentId: s.studentId,
        fullName: s.fullName,
        classGroupId: s.classGroupId,
        className: [s.grade, s.stream].filter(Boolean).join(' '),
        teacherName: s.teacherName,
        guardianPhone: s.guardianPhone,
        guardianEmail: s.guardianEmail,
        flag: assessment.flag,
        dropoutProbability: assessment.dropoutProbability,
        lastFollowUpAt: lastAt,
        needsFollowUp,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.dropoutProbability - a.dropoutProbability);
}

export function getSchoolOverview(db, schoolId) {
  const date = todayISO();
  const classes = getClassesForSchool(db, schoolId);
  const studentCount = classes.reduce((sum, c) => sum + c.studentCount, 0);

  const todayCounts = db
    .prepare(
      `SELECT a.status, COUNT(*) AS n
         FROM attendance_events a
         JOIN students s ON s.student_id = a.student_id
         JOIN class_groups c ON c.class_group_id = s.class_group_id
        WHERE c.school_id = ? AND a.date = ?
        GROUP BY a.status`
    )
    .all(schoolId, date);
  const byStatus = Object.fromEntries(todayCounts.map((r) => [r.status, r.n]));
  const recordedToday = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const attendedToday = (byStatus.present ?? 0) + (byStatus.late ?? 0);

  const flagged = getFlaggedStudents(db, schoolId);

  return {
    schoolId,
    date,
    classCount: classes.length,
    studentCount,
    recordedToday,
    attendanceRateToday: recordedToday > 0 ? attendedToday / recordedToday : null,
    flaggedCount: flagged.length,
    needsFollowUpCount: flagged.filter((f) => f.needsFollowUp).length,
  };
}

// --------------------------------------------------------------------------- //
// Follow-ups                                                                  //
// --------------------------------------------------------------------------- //

export function addFollowUp(db, { studentId, flag, method, note = null, actor = null }) {
  const info = db
    .prepare(`INSERT INTO follow_ups (student_id, flag, method, note, actor) VALUES (?, ?, ?, ?, ?)`)
    .run(studentId, flag, method, note, actor);
  logAudit(db, { action: 'followup.logged', actorId: actor, recordId: studentId, detail: { flag, method } });
  return db.prepare(`SELECT * FROM follow_ups WHERE id = ?`).get(info.lastInsertRowid);
}

export function getFollowUps(db, studentId) {
  return db.prepare(`SELECT * FROM follow_ups WHERE student_id = ? ORDER BY created_at DESC`).all(studentId);
}
