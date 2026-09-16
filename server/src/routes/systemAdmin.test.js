import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../db/index.js';
import { createApp } from '../app.js';

let db;
let server;
let base;

beforeEach(async () => {
  db = openDatabase(':memory:');
  server = createApp({ db, logger: false }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  db.prepare(`INSERT INTO schools (school_id, name, county) VALUES ('school-1', 'Kibera Secondary', 'Nairobi')`).run();
  db.prepare(`INSERT INTO schools (school_id, name, county) VALUES ('school-2', 'Moi Girls', 'Nairobi')`).run();
  db.prepare(`INSERT INTO class_groups (class_group_id, school_id, grade, academic_year) VALUES ('class-a', 'school-1', 'Form 3', 2026)`).run();
  db.prepare(`INSERT INTO students (student_id, class_group_id, admission_no, full_name) VALUES ('stu-1', 'class-a', 'A/001', 'Test Student')`).run();
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  db.close();
});

describe('GET /api/system-admin/schools', () => {
  test('lists every school with counts and default active status', async () => {
    const res = await fetch(`${base}/api/system-admin/schools`);
    const { schools } = await res.json();
    assert.equal(res.status, 200);
    assert.equal(schools.length, 2);
    const s1 = schools.find((s) => s.schoolId === 'school-1');
    assert.equal(s1.status, 'active');
    assert.equal(s1.classCount, 1);
    assert.equal(s1.studentCount, 1);
  });
});

describe('POST /api/system-admin/schools/:id/status', () => {
  test('deactivates a school', async () => {
    const res = await fetch(`${base}/api/system-admin/schools/school-1/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'inactive' }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.status, 'inactive');

    const listRes = await fetch(`${base}/api/system-admin/schools`);
    const { schools } = await listRes.json();
    assert.equal(schools.find((s) => s.schoolId === 'school-1').status, 'inactive');
  });

  test('404 for an unknown school', async () => {
    const res = await fetch(`${base}/api/system-admin/schools/nope/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'inactive' }),
    });
    assert.equal(res.status, 404);
  });

  test('400 for an invalid status', async () => {
    const res = await fetch(`${base}/api/system-admin/schools/school-1/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    });
    assert.equal(res.status, 400);
  });
});
