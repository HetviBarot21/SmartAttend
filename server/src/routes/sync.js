/**
 * POST /api/sync: attendance batches from the PWA.
 *
 * Pipeline position: PWA (IndexedDB queue) -> **here** -> sync_queue table ->
 * syncWorker.js -> AWS. This handler is the durable landing point: once it
 * answers 200 the record is safe on the server's disk and the PWA can drop it
 * from its local queue.
 *
 * Behaviour:
 *   1. Validate the whole batch against attendanceSync.schema.js. A malformed
 *      batch is rejected 400 and nothing is written.
 *   2. For each record, look it up by eventId (the device idempotency key).
 *        - not seen before, and (studentId, date) is free  -> insert
 *        - seen before, same status and reason             -> skip (duplicate)
 *        - seen before, status or reason changed           -> update in place
 *          (a teacher corrected a mark, or added an absence reason later)
 *          and re-queue for AWS
 *        - a *different* eventId already covers (studentId, date) -> skip
 *   3. Insert / update survivors and (re-)enqueue them in sync_queue, one
 *      transaction per record.
 *   4. Respond 200 with a per-record summary. Updated records are reported in
 *      `inserted` so the PWA settles them the same way.
 */

import { Router } from 'express';
import { validate } from '../lib/validate.js';
import { attendanceSyncSchema } from '../schemas/attendanceSync.schema.js';

/**
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db  the process-wide connection
 */
export function createSyncRouter({ db }) {
  if (!db) throw new Error('createSyncRouter needs a db');
  const router = Router();

  const findEvent = db.prepare('SELECT status, reason FROM attendance_events WHERE event_id = ?');
  const findByStudentDate = db.prepare(
    'SELECT event_id FROM attendance_events WHERE student_id = ? AND date = ?'
  );
  const insertEvent = db.prepare(`
    INSERT INTO attendance_events
      (event_id, student_id, date, status, capture_method, recorded_by, reason, source, created_at)
    VALUES
      (@eventId, @studentId, @date, @status, @captureMethod, @recordedBy, @reason, 'client', @createdAt)
  `);
  const updateEvent = db.prepare(`
    UPDATE attendance_events
       SET status = @status, capture_method = @captureMethod,
           recorded_by = @recordedBy, reason = @reason, synced_at = NULL
     WHERE event_id = @eventId
  `);
  const enqueue = db.prepare(`
    INSERT INTO sync_queue (event_id, payload, status)
    VALUES (@eventId, @payload, 'pending')
    ON CONFLICT (event_id) DO UPDATE SET
      payload = excluded.payload,
      status = 'pending',
      attempt_count = 0,
      next_attempt_at = NULL,
      last_error = NULL,
      synced_at = NULL
  `);
  const audit = db.prepare(`
    INSERT INTO audit_log (action, actor_id, record_id, detail)
    VALUES (?, ?, ?, ?)
  `);

  const normalize = (record) => ({
    eventId: record.eventId,
    studentId: record.studentId,
    date: record.date,
    status: record.status,
    captureMethod: record.captureMethod || 'manual',
    recordedBy: record.recordedBy ?? null,
    // A reason only means something on an absence - drop it otherwise, so a
    // mark corrected from absent to present doesn't keep a stale reason.
    reason: record.status === 'absent' ? record.reason ?? null : null,
    createdAt: record.createdAt,
  });

  const acceptRecord = db.transaction((record, deviceId) => {
    const normalized = normalize(record);
    insertEvent.run(normalized);
    enqueue.run({ eventId: normalized.eventId, payload: JSON.stringify(normalized) });
    audit.run(
      'sync.received',
      normalized.recordedBy ?? deviceId ?? null,
      normalized.eventId,
      JSON.stringify({ deviceId, studentId: normalized.studentId, date: normalized.date })
    );
  });

  /** Apply a corrected status to a record already on the server, and re-queue it. */
  const acceptUpdate = db.transaction((record, deviceId, existing) => {
    const normalized = normalize(record);
    updateEvent.run(normalized);
    enqueue.run({ eventId: normalized.eventId, payload: JSON.stringify(normalized) });
    audit.run(
      'sync.updated',
      normalized.recordedBy ?? deviceId ?? null,
      normalized.eventId,
      JSON.stringify({
        deviceId,
        from: existing.status,
        to: normalized.status,
        fromReason: existing.reason,
        toReason: normalized.reason,
      })
    );
  });

  router.post('/', (req, res) => {
    const { valid, errors } = validate(attendanceSyncSchema, req.body);
    if (!valid) {
      return res.status(400).json({ error: 'invalid sync payload', details: errors });
    }

    const { records, deviceId } = req.body;
    const inserted = [];
    const skipped = [];

    const updated = [];

    for (const record of records) {
      // Seen this exact record before? Either nothing changed (skip) or the
      // teacher corrected the mark or added a reason later (update in place +
      // re-queue).
      const existing = findEvent.get(record.eventId);
      if (existing) {
        const { status, reason } = normalize(record);
        if (existing.status === status && existing.reason === reason) {
          skipped.push({ eventId: record.eventId, reason: 'duplicate_event_id' });
        } else {
          try {
            acceptUpdate(record, deviceId, existing);
            inserted.push(record.eventId);
            updated.push(record.eventId);
          } catch (err) {
            console.error('[sync] update failed', err);
            skipped.push({ eventId: record.eventId, reason: 'insert_error' });
          }
        }
        continue;
      }
      const clash = findByStudentDate.get(record.studentId, record.date);
      if (clash) {
        skipped.push({
          eventId: record.eventId,
          reason: 'duplicate_student_date',
          existingEventId: clash.event_id,
        });
        continue;
      }

      try {
        acceptRecord(record, deviceId);
        inserted.push(record.eventId);
      } catch (err) {
        const code = err && err.code;
        if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
          skipped.push({ eventId: record.eventId, reason: 'unknown_student' });
        } else if (/UNIQUE constraint failed/.test(err?.message || '')) {
          // A concurrent request inserted it first.
          skipped.push({ eventId: record.eventId, reason: 'duplicate_race' });
        } else {
          console.error('[sync] insert failed', err);
          skipped.push({ eventId: record.eventId, reason: 'insert_error' });
        }
      }
    }

    return res.status(200).json({
      received: records.length,
      insertedCount: inserted.length,
      updatedCount: updated.length,
      skippedCount: skipped.length,
      inserted,
      updated,
      skipped,
    });
  });

  return router;
}
