import { randomUUID } from 'node:crypto';

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
  if (!['manual', 'rfid', 'fingerprint'].includes(captureMethod)) {
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

    db.prepare(`INSERT INTO sync_queue (event_id, status) VALUES (?, 'pending')`).run(eventId);

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
