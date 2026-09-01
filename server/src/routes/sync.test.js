'use strict';

process.env.SQLITE_PATH = ':memory:';
process.env.SYNC_WORKER_DISABLED = 'true';

const crypto = require('crypto');
const request = require('supertest');
const { createApp } = require('../app');
const { db } = require('../db');

const app = createApp();

function record(over = {}) {
  return {
    eventId: crypto.randomUUID(),
    studentId: 'stu-form3b-001',
    date: '2026-02-16',
    status: 'present',
    createdAt: '2026-02-16T07:30:00.000Z',
    ...over
  };
}

afterEach(() => {
  db.exec('DELETE FROM attendance_events; DELETE FROM sync_queue; DELETE FROM audit_log;');
});

describe('POST /api/sync', () => {
  test('rejects a payload with no records array', async () => {
    const res = await request(app).post('/api/sync').send({ deviceId: 'd1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid sync payload/);
  });

  test('rejects a record with an invalid status', async () => {
    const res = await request(app)
      .post('/api/sync')
      .send({ records: [record({ status: 'holiday' })] });
    expect(res.status).toBe(400);
  });

  test('rejects a non-uuid eventId', async () => {
    const res = await request(app)
      .post('/api/sync')
      .send({ records: [record({ eventId: 'not-a-uuid' })] });
    expect(res.status).toBe(400);
  });

  test('inserts a new record and enqueues it for cloud sync', async () => {
    const rec = record();
    const res = await request(app).post('/api/sync').send({ deviceId: 'd1', records: [rec] });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: 1, insertedCount: 1, skippedCount: 0 });
    expect(res.body.inserted).toEqual([rec.eventId]);

    expect(db.prepare('SELECT COUNT(*) c FROM attendance_events').get().c).toBe(1);
    const queued = db.prepare('SELECT status FROM sync_queue WHERE event_id = ?').get(rec.eventId);
    expect(queued.status).toBe('pending');
    expect(db.prepare('SELECT COUNT(*) c FROM audit_log').get().c).toBe(1);
  });

  test('skips a re-sent eventId (idempotent replay)', async () => {
    const rec = record();
    await request(app).post('/api/sync').send({ records: [rec] });
    const res = await request(app).post('/api/sync').send({ records: [rec] });

    expect(res.status).toBe(200);
    expect(res.body.insertedCount).toBe(0);
    expect(res.body.skipped).toEqual([{ eventId: rec.eventId, reason: 'duplicate_event_id' }]);
    expect(db.prepare('SELECT COUNT(*) c FROM attendance_events').get().c).toBe(1);
  });

  test('skips a different event that collides on student + date', async () => {
    const first = record();
    await request(app).post('/api/sync').send({ records: [first] });

    const second = record({ status: 'late' }); // same student + date, new eventId
    const res = await request(app).post('/api/sync').send({ records: [second] });

    expect(res.body.insertedCount).toBe(0);
    expect(res.body.skipped[0]).toMatchObject({
      eventId: second.eventId,
      reason: 'duplicate_student_date',
      existingEventId: first.eventId
    });
  });

  test('settles a mixed batch: some inserted, some skipped', async () => {
    const existing = record({ studentId: 'stu-a', date: '2026-02-16' });
    await request(app).post('/api/sync').send({ records: [existing] });

    const batch = [
      record({ studentId: 'stu-a', date: '2026-02-16' }), // collides -> skip
      record({ studentId: 'stu-b', date: '2026-02-16' }), // new -> insert
      record({ studentId: 'stu-c', date: '2026-02-16' }) // new -> insert
    ];
    const res = await request(app).post('/api/sync').send({ records: batch });

    expect(res.body.insertedCount).toBe(2);
    expect(res.body.skippedCount).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM sync_queue').get().c).toBe(3);
  });
});
