import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../db/index.js';
import { seed } from '../db/seed.js';
import { recordAttendance, todayISO } from '../db/repository.js';
import { createApp } from '../app.js';

let db;
let server;
let base;

const CLASS = 'class-form3b-001';

beforeEach(async () => {
  db = openDatabase(':memory:');
  seed(db);
  server = createApp({ db, logger: false }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  // a second class in the same school, to prove the class filter
  db.prepare(`INSERT INTO class_groups (class_group_id, school_id, grade, academic_year)
              VALUES ('class-other', 'school-kibera-001', 'Form 1', 2026)`).run();
  db.prepare(`INSERT INTO students (student_id, class_group_id, admission_no, full_name)
              VALUES ('stu-other-1', 'class-other', 'O/001', 'Other Class Student')`).run();
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  db.close();
});

const getClassAttendance = (classId, query = '') =>
  fetch(`${base}/api/gate/classes/${classId}/attendance${query}`);

describe('GET /api/gate/classes/:id/attendance', () => {
  test('404 for a class the server does not know', async () => {
    const res = await getClassAttendance('class-nope');
    assert.equal(res.status, 404);
  });

  test('400 for a malformed date', async () => {
    const res = await getClassAttendance(CLASS, '?date=29-09-2026');
    assert.equal(res.status, 400);
  });

  test('empty day: no records and no gate activity yet', async () => {
    const body = await (await getClassAttendance(CLASS)).json();
    assert.equal(body.classGroupId, CLASS);
    assert.equal(body.date, todayISO());
    assert.deepEqual(body.records, []);
    assert.equal(body.gate.lastScanAt, null);
  });

  test("returns today's gate scans in the PWA's shape, keeping the server eventId", async () => {
    const scan = recordAttendance(db, { studentId: 'stu-form3b-001', captureMethod: 'fingerprint', verified: 1 });

    const body = await (await getClassAttendance(CLASS)).json();
    assert.equal(body.records.length, 1);
    const [r] = body.records;
    assert.equal(r.eventId, scan.eventId);
    assert.equal(r.studentId, 'stu-form3b-001');
    assert.equal(r.status, 'present');
    assert.equal(r.captureMethod, 'fingerprint');
    assert.equal(r.verified, true);
    assert.equal(r.source, 'simulation');
    assert.match(r.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(body.gate.lastScanAt, r.createdAt);
  });

  test('includes teacher marks synced from a phone, with their absence reason', async () => {
    const eventId = randomUUID();
    await fetch(`${base}/api/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        records: [{ eventId, studentId: 'stu-form3b-002', date: todayISO(), status: 'absent', reason: 'fee', createdAt: new Date().toISOString() }],
      }),
    });

    const body = await (await getClassAttendance(CLASS)).json();
    const r = body.records.find((x) => x.eventId === eventId);
    assert.equal(r.status, 'absent');
    assert.equal(r.reason, 'fee');
    assert.equal(r.source, 'client');
    // a teacher mark is not a gate scan
    assert.equal(body.gate.lastScanAt, null);
  });

  test('only returns students in the requested class', async () => {
    recordAttendance(db, { studentId: 'stu-form3b-001', captureMethod: 'rfid' });
    recordAttendance(db, { studentId: 'stu-other-1', captureMethod: 'rfid' });

    const body = await (await getClassAttendance(CLASS)).json();
    assert.deepEqual(body.records.map((r) => r.studentId), ['stu-form3b-001']);
  });

  test('filters by the requested date', async () => {
    recordAttendance(db, { studentId: 'stu-form3b-001', captureMethod: 'rfid', date: '2026-09-01' });
    recordAttendance(db, { studentId: 'stu-form3b-001', captureMethod: 'rfid', date: '2026-09-02' });

    const body = await (await getClassAttendance(CLASS, '?date=2026-09-01')).json();
    assert.equal(body.records.length, 1);
    assert.equal(body.records[0].date, '2026-09-01');
  });
});
