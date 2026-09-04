import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../db/index.js';
import { seed } from '../db/seed.js';
import { createApp } from '../app.js';

let db;
let server;
let base;

beforeEach(async () => {
  db = openDatabase(':memory:');
  seed(db);
  server = createApp({ db, logger: false }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  db.close();
});

const postSync = (body) =>
  fetch(`${base}/api/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

function record(over = {}) {
  return {
    eventId: randomUUID(),
    studentId: 'stu-form3b-001',
    date: '2026-02-16',
    status: 'present',
    createdAt: '2026-02-16T07:30:00.000Z',
    ...over,
  };
}

const count = (sql, ...args) => db.prepare(sql).get(...args).c;

describe('POST /api/sync', () => {
  test('rejects a payload with no records array', async () => {
    const res = await postSync({ deviceId: 'd1' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /invalid sync payload/);
  });

  test('rejects a record with an invalid status', async () => {
    const res = await postSync({ records: [record({ status: 'holiday' })] });
    assert.equal(res.status, 400);
  });

  test('rejects a non-uuid eventId', async () => {
    const res = await postSync({ records: [record({ eventId: 'not-a-uuid' })] });
    assert.equal(res.status, 400);
  });

  test('inserts a new record and enqueues it for cloud sync', async () => {
    const rec = record();
    const res = await postSync({ deviceId: 'd1', records: [rec] });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.received, 1);
    assert.equal(body.insertedCount, 1);
    assert.equal(body.skippedCount, 0);
    assert.deepEqual(body.inserted, [rec.eventId]);

    assert.equal(count('SELECT COUNT(*) c FROM attendance_events'), 1);
    const queued = db.prepare('SELECT status, payload FROM sync_queue WHERE event_id = ?').get(rec.eventId);
    assert.equal(queued.status, 'pending');
    assert.equal(JSON.parse(queued.payload).studentId, rec.studentId);
    assert.equal(count("SELECT COUNT(*) c FROM audit_log WHERE action = 'sync.received'"), 1);
    assert.equal(
      db.prepare('SELECT source FROM attendance_events WHERE event_id = ?').get(rec.eventId).source,
      'client'
    );
  });

  test('skips a re-sent eventId (idempotent replay)', async () => {
    const rec = record();
    await postSync({ records: [rec] });
    const res = await postSync({ records: [rec] });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.insertedCount, 0);
    assert.deepEqual(body.skipped, [{ eventId: rec.eventId, reason: 'duplicate_event_id' }]);
    assert.equal(count('SELECT COUNT(*) c FROM attendance_events'), 1);
  });

  test('skips a different event that collides on student + date', async () => {
    const first = record();
    await postSync({ records: [first] });

    const second = record({ status: 'late' }); // same student + date, new eventId
    const res = await postSync({ records: [second] });
    const body = await res.json();

    assert.equal(body.insertedCount, 0);
    assert.equal(body.skipped[0].eventId, second.eventId);
    assert.equal(body.skipped[0].reason, 'duplicate_student_date');
    assert.equal(body.skipped[0].existingEventId, first.eventId);
  });

  test('skips a record for a student not on this roster', async () => {
    const res = await postSync({ records: [record({ studentId: 'stu-not-seeded' })] });
    const body = await res.json();
    assert.equal(body.insertedCount, 0);
    assert.equal(body.skipped[0].reason, 'unknown_student');
  });

  test('settles a mixed batch: some inserted, some skipped', async () => {
    const existing = record({ studentId: 'stu-form3b-001' });
    await postSync({ records: [existing] });

    const batch = [
      record({ studentId: 'stu-form3b-001' }), // collides -> skip
      record({ studentId: 'stu-form3b-002' }), // new -> insert
      record({ studentId: 'stu-form3b-003' }), // new -> insert
    ];
    const res = await postSync({ records: batch });
    const body = await res.json();

    assert.equal(body.insertedCount, 2);
    assert.equal(body.skippedCount, 1);
    assert.equal(count('SELECT COUNT(*) c FROM sync_queue'), 3);
  });
});
