/**
 * POST /api/sync: attendance batches from the PWA.
 *
 * A malformed batch is rejected with 400. Each record is then matched by eventId:
 *   - new, and (studentId, date) is free   -> insert
 *   - known, same status                   -> skip
 *   - known, status changed                -> update and re-queue
 *   - another eventId has (studentId, date) -> skip
 * Updated records are reported in `inserted`.
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
