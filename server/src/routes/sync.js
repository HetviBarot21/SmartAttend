/**
 * POST /api/sync - inbound attendance sync from the offline PWA.
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
 *        - seen before, same status                        -> skip (duplicate)
 *        - seen before, status changed                     -> update in place
 *          (a teacher corrected a mark during the day) and re-queue for AWS
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

  const findEvent = db.prepare('SELECT status FROM attendance_events WHERE event_id = ?');
  const findByStudentDate = db.prepare(
    'SELECT event_id FROM attendance_events WHERE student_id = ? AND date = ?'
  );
  const insertEvent = db.prepare(`
    INSERT INTO attendance_events
      (event_id, student_id, date, status, capture_method, recorded_by, source, created_at)
    VALUES
      (@eventId, @studentId, @date, @status, @captureMethod, @recordedBy, 'client', @createdAt)
  `);
  const updateEvent = db.prepare(`
    UPDATE attendance_events
       SET status = @status, capture_method = @captureMethod,
           recorded_by = @recordedBy, synced_at = NULL
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
    createdAt: record.createdAt,
  });

  /** Insert one record + enqueue it + audit it, atomically. */
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
  const acceptUpdate = db.transaction((record, deviceId, fromStatus) => {
    const normalized = normalize(record);
    updateEvent.run(normalized);
    enqueue.run({ eventId: normalized.eventId, payload: JSON.stringify(normalized) });
    audit.run(
      'sync.updated',
      normalized.recordedBy ?? deviceId ?? null,
      normalized.eventId,
      JSON.stringify({ deviceId, from: fromStatus, to: normalized.status })
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
      // teacher corrected the mark (update in place + re-queue).
      const existing = findEvent.get(record.eventId);
      if (existing) {
        if (existing.status === record.status) {
          skipped.push({ eventId: record.eventId, reason: 'duplicate_event_id' });
        } else {
          try {
            acceptUpdate(record, deviceId, existing.status);
            inserted.push(record.eventId);
            updated.push(record.eventId);
          } catch (err) {
            console.error('[sync] update failed', err);
            skipped.push({ eventId: record.eventId, reason: 'insert_error' });
          }
        }
        continue;
      }
      // A different event already covers this student/day.
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
          // The PWA sent a student this server's roster does not know. The demo
          // rosters are seeded identically, so this is a data issue, not a retry.
          skipped.push({ eventId: record.eventId, reason: 'unknown_student' });
        } else if (/UNIQUE constraint failed/.test(err?.message || '')) {
          // A concurrent request won the race; treat as a skip so the PWA batch
          // still settles cleanly.
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
