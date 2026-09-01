'use strict';

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
 *   2. For each record, deduplicate on eventId (the device idempotency key) and
 *      on the (studentId, date) natural key. Re-sent records are skipped, not
 *      errors - the PWA retries whole batches.
 *   3. Insert survivors into attendance_events and enqueue them in sync_queue,
 *      in one transaction per record.
 *   4. Respond 200 with a per-record summary.
 */

const express = require('express');
const { db } = require('../db');
const { validate } = require('../lib/validate');
const { attendanceSyncSchema } = require('../schemas/attendanceSync.schema');

const router = express.Router();

const findEvent = db.prepare('SELECT 1 FROM attendance_events WHERE event_id = ?');
const findByStudentDate = db.prepare(
  'SELECT event_id FROM attendance_events WHERE student_id = ? AND date = ?'
);
const insertEvent = db.prepare(`
  INSERT INTO attendance_events
    (event_id, student_id, date, status, capture_method, recorded_by, created_at)
  VALUES
    (@eventId, @studentId, @date, @status, @captureMethod, @recordedBy, @createdAt)
`);
const enqueue = db.prepare(`
  INSERT INTO sync_queue (event_id, payload, status)
  VALUES (@eventId, @payload, 'pending')
  ON CONFLICT (event_id) DO NOTHING
`);
const audit = db.prepare(`
  INSERT INTO audit_log (action, actor_id, record_id, detail)
  VALUES (?, ?, ?, ?)
`);

/** Insert one record + enqueue it + audit it, atomically. */
const acceptRecord = db.transaction((record, deviceId) => {
  insertEvent.run({
    eventId: record.eventId,
    studentId: record.studentId,
    date: record.date,
    status: record.status,
    captureMethod: record.captureMethod || 'manual',
    recordedBy: record.recordedBy ?? null,
    createdAt: record.createdAt
  });
  enqueue.run({ eventId: record.eventId, payload: JSON.stringify(record) });
  audit.run('sync.received', record.recordedBy ?? deviceId ?? null, record.eventId,
    JSON.stringify({ deviceId, studentId: record.studentId, date: record.date }));
});

router.post('/', (req, res) => {
  const { valid, errors } = validate(attendanceSyncSchema, req.body);
  if (!valid) {
    return res.status(400).json({ error: 'invalid sync payload', details: errors });
  }

  const { records, deviceId } = req.body;
  const inserted = [];
  const skipped = [];

  for (const record of records) {
    // Dedup 1: exact idempotency key already stored.
    if (findEvent.get(record.eventId)) {
      skipped.push({ eventId: record.eventId, reason: 'duplicate_event_id' });
      continue;
    }
    // Dedup 2: a different event already covers this student/day.
    const clash = findByStudentDate.get(record.studentId, record.date);
    if (clash) {
      skipped.push({
        eventId: record.eventId,
        reason: 'duplicate_student_date',
        existingEventId: clash.event_id
      });
      continue;
    }

    try {
      acceptRecord(record, deviceId);
      inserted.push(record.eventId);
    } catch (err) {
      // A UNIQUE violation here means a concurrent request won the race; treat
      // it as a skip, not a failure, so the PWA batch still settles cleanly.
      if (err && /UNIQUE constraint failed/.test(err.message)) {
        skipped.push({ eventId: record.eventId, reason: 'duplicate_race' });
      } else {
        req.log?.error?.(err) || console.error('[sync] insert failed', err);
        skipped.push({ eventId: record.eventId, reason: 'insert_error' });
      }
    }
  }

  return res.status(200).json({
    received: records.length,
    insertedCount: inserted.length,
    skippedCount: skipped.length,
    inserted,
    skipped
  });
});

module.exports = router;
