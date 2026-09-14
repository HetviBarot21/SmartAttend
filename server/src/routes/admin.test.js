import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../db/index.js';
import { createApp } from '../app.js';
import { recordAttendance } from '../db/repository.js';

let db;
let server;
let base;

function isoAddDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

beforeEach(async () => {
  db = openDatabase(':memory:');
  server = createApp({ db, logger: false }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  db.prepare(`INSERT INTO schools (school_id, name) VALUES ('school-1', 'Test School')`).run();
  db.prepare(`INSERT INTO class_groups (class_group_id, school_id, grade, stream, academic_year, teacher_name)
              VALUES ('class-a', 'school-1', 'Form 3', 'A', 2026, 'Ms. Otieno')`).run();
  db.prepare(`INSERT INTO class_groups (class_group_id, school_id, grade, stream, academic_year, teacher_name)
              VALUES ('class-b', 'school-1', 'Form 4', 'B', 2026, 'Mr. Kamau')`).run();
  db.prepare(`INSERT INTO students (student_id, class_group_id, admission_no, full_name) VALUES
              ('stu-steady', 'class-a', 'A/001', 'Steady Student'),
              ('stu-chronic', 'class-b', 'B/001', 'Chronic Absentee')`).run();
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  db.close();
});

/** Back-fill the last 28 school days: 'steady' student mostly present, 'chronic' mostly absent recently. */
function seedTwoMonthsHistory() {
  const today = new Date();
  for (let n = 40; n >= 1; n -= 1) {
    const date = isoAddDays(
      `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`,
      -n
    );
    const dow = new Date(date).getDay();
    if (dow === 0 || dow === 6) continue;
    recordAttendance(db, { studentId: 'stu-steady', date, status: 'present', captureMethod: 'import' });
    recordAttendance(db, { studentId: 'stu-chronic', date, status: n <= 10 ? 'absent' : 'present', captureMethod: 'import' });
  }
}

describe('GET /api/admin/schools/:id/overview', () => {
  test('aggregates across every class in the school', async () => {
    seedTwoMonthsHistory();
    const res = await fetch(`${base}/api/admin/schools/school-1/overview`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.classCount, 2);
    assert.equal(body.studentCount, 2);
    assert.ok(body.flaggedCount >= 1);
  });
});

describe('GET /api/admin/schools/:id/classes', () => {
  test('lists classes with teacher and roster size', async () => {
    const res = await fetch(`${base}/api/admin/schools/school-1/classes`);
    const { classes } = await res.json();
    assert.equal(classes.length, 2);
    const a = classes.find((c) => c.classGroupId === 'class-a');
    assert.equal(a.teacherName, 'Ms. Otieno');
    assert.equal(a.studentCount, 1);
  });
});

describe('GET /api/admin/schools/:id/flagged', () => {
  test('flags the chronic absentee but not the steady student', async () => {
    seedTwoMonthsHistory();
    const res = await fetch(`${base}/api/admin/schools/school-1/flagged`);
    const { flagged } = await res.json();
    const ids = flagged.map((f) => f.studentId);
    assert.ok(ids.includes('stu-chronic'));
    assert.ok(!ids.includes('stu-steady'));
    assert.equal(flagged.find((f) => f.studentId === 'stu-chronic').needsFollowUp, true);
  });
});

describe('follow-ups', () => {
  test('logging a follow-up clears needsFollowUp until it goes stale', async () => {
    seedTwoMonthsHistory();
    const logRes = await fetch(`${base}/api/admin/students/stu-chronic/follow-ups`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ flag: 'red', method: 'parent_call', note: 'Spoke to guardian', actor: 'admin@school' }),
    });
    assert.equal(logRes.status, 201);

    const flaggedRes = await fetch(`${base}/api/admin/schools/school-1/flagged`);
    const { flagged } = await flaggedRes.json();
    assert.equal(flagged.find((f) => f.studentId === 'stu-chronic').needsFollowUp, false);

    const historyRes = await fetch(`${base}/api/admin/students/stu-chronic/follow-ups`);
    const { followUps } = await historyRes.json();
    assert.equal(followUps.length, 1);
    assert.equal(followUps[0].method, 'parent_call');
  });

  test('400 when flag or method is missing', async () => {
    const res = await fetch(`${base}/api/admin/students/stu-chronic/follow-ups`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'no flag or method' }),
    });
    assert.equal(res.status, 400);
  });
});
