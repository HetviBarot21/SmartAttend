import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from './index.js';
import { seed } from './seed.js';
import {
  recordAttendance,
  countPendingSync,
  getAttendanceForDate,
  findStudentByCardUid,
  logFingerprintChallenge,
  getStats,
  todayISO,
  DuplicateAttendanceError,
} from './repository.js';

const DATE = '2026-08-28';
const OTHER_DATE = '2026-08-29';
const STUDENT = 'stu-form3b-001';

let db;
beforeEach(() => {
  db = openDatabase(':memory:');
  seed(db);
});

describe('schema', () => {
  test('creates all 8 tables', () => {
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => r.name);
    assert.deepEqual(names, [
      'attendance_events',
      'audit_log',
      'class_groups',
      'fingerprint_challenges',
      'rfid_cards',
      'schools',
      'students',
      'sync_queue',
    ]);
  });

  test('seed loads the demo class and binds a card to every student', () => {
    assert.equal(db.prepare('SELECT COUNT(*) n FROM students').get().n, 10);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM rfid_cards WHERE active = 1').get().n, 10);
    assert.equal(findStudentByCardUid(db, '04A1B2C3')?.student_id, STUDENT);
    assert.equal(findStudentByCardUid(db, 'NOPE'), null);
  });
});

describe('recordAttendance - writing a record', () => {
  test('persists the event and enqueues it for sync, atomically', () => {
    const event = recordAttendance(db, {
      studentId: STUDENT,
      date: DATE,
      status: 'present',
      captureMethod: 'rfid',
    });

    assert.ok(event.eventId);
    const row = db.prepare('SELECT * FROM attendance_events WHERE event_id = ?').get(event.eventId);
    assert.equal(row.student_id, STUDENT);
    assert.equal(row.date, DATE);
    assert.equal(row.capture_method, 'rfid');
    assert.equal(row.source, 'simulation');

    assert.equal(countPendingSync(db), 1);
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'attendance.recorded'").get().n,
      1
    );
  });

  test('stores the capture_method it is given', () => {
    for (const [i, method] of ['manual', 'rfid', 'fingerprint'].entries()) {
      const e = recordAttendance(db, {
        studentId: `stu-form3b-00${i + 1}`,
        date: DATE,
        captureMethod: method,
      });
      assert.equal(
        db.prepare('SELECT capture_method FROM attendance_events WHERE event_id = ?').get(e.eventId).capture_method,
        method
      );
    }
  });

  test('rejects an unknown capture_method before touching the db', () => {
    assert.throws(() => recordAttendance(db, { studentId: STUDENT, date: DATE, captureMethod: 'retina' }));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM attendance_events').get().n, 0);
  });
});

describe('duplicate prevention', () => {
  test('a second record for the same student and date is rejected', () => {
    recordAttendance(db, { studentId: STUDENT, date: DATE, captureMethod: 'rfid' });

    assert.throws(
      () => recordAttendance(db, { studentId: STUDENT, date: DATE, captureMethod: 'fingerprint' }),
      DuplicateAttendanceError
    );
  });

  test('the rejected write leaves no partial rows behind', () => {
    recordAttendance(db, { studentId: STUDENT, date: DATE, captureMethod: 'rfid' });
    try {
      recordAttendance(db, { studentId: STUDENT, date: DATE, captureMethod: 'rfid' });
    } catch {
      /* expected */
    }
    assert.equal(db.prepare('SELECT COUNT(*) n FROM attendance_events').get().n, 1);
    assert.equal(countPendingSync(db), 1); // no orphan sync-queue row
    assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_log').get().n, 1);
  });

  test('the same student on a different date is allowed', () => {
    recordAttendance(db, { studentId: STUDENT, date: DATE, captureMethod: 'rfid' });
    assert.doesNotThrow(() =>
      recordAttendance(db, { studentId: STUDENT, date: OTHER_DATE, captureMethod: 'rfid' })
    );
    assert.equal(getAttendanceForDate(db, DATE).length, 1);
    assert.equal(getAttendanceForDate(db, OTHER_DATE).length, 1);
  });

  test('different students on the same date are allowed', () => {
    recordAttendance(db, { studentId: 'stu-form3b-001', date: DATE, captureMethod: 'rfid' });
    recordAttendance(db, { studentId: 'stu-form3b-002', date: DATE, captureMethod: 'rfid' });
    assert.equal(getAttendanceForDate(db, DATE).length, 2);
  });

  test('a reused event_id is rejected (idempotency key)', () => {
    recordAttendance(db, { studentId: 'stu-form3b-001', date: DATE, captureMethod: 'rfid', eventId: 'evt-1' });
    assert.throws(() =>
      recordAttendance(db, { studentId: 'stu-form3b-002', date: DATE, captureMethod: 'rfid', eventId: 'evt-1' })
    );
  });
});

describe('getStats', () => {
  test('counts today\'s records by method and today\'s challenges', () => {
    const today = todayISO();
    recordAttendance(db, { studentId: 'stu-form3b-001', date: today, captureMethod: 'rfid' });
    recordAttendance(db, { studentId: 'stu-form3b-002', date: today, captureMethod: 'fingerprint', verified: 1 });
    logFingerprintChallenge(db, {
      studentId: 'stu-form3b-002', cardUid: '04D4E5F6', eventId: null, result: 'match', successRate: 0.9,
    });

    const stats = getStats(db, today);
    assert.equal(stats.totalAttendance, 2);
    assert.deepEqual(stats.attendanceByMethod, { rfid: 1, fingerprint: 1 });
    assert.equal(stats.challenges.match, 1);
    assert.equal(stats.challenges.total, 1);
    assert.equal(stats.pendingSync, 2);
  });
});
