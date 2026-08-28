import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../db/index.js';
import { seed } from '../db/seed.js';
import { todayISO } from '../db/repository.js';
import { createCardHandler } from './handler.js';

const CARD = '04A1B2C3'; // stu-form3b-001
const CARD_2 = '04D4E5F6'; // stu-form3b-002

let db;
beforeEach(() => {
  db = openDatabase(':memory:');
  seed(db);
});

const countAttendance = () => db.prepare('SELECT COUNT(*) n FROM attendance_events').get().n;
const rowFor = (studentId) =>
  db.prepare('SELECT * FROM attendance_events WHERE student_id = ?').get(studentId);

describe('createCardHandler - simulated scans write to SQLite', () => {
  test('no challenge: records attendance as capture_method "rfid", unverified', () => {
    const handle = createCardHandler({ db, challengeRate: 0 });
    const result = handle({ cardUid: CARD });

    assert.equal(result.outcome, 'recorded');
    assert.equal(result.challenged, false);
    const row = rowFor('stu-form3b-001');
    assert.equal(row.capture_method, 'rfid');
    assert.equal(row.verified, 0);
    assert.equal(row.status, 'present');
    assert.equal(row.date, todayISO());
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sync_queue WHERE status='pending'").get().n, 1);
  });

  test('challenge + match: capture_method "fingerprint", verified, challenge linked to event', () => {
    const handle = createCardHandler({ db, challengeRate: 1, successRate: 1 });
    const result = handle({ cardUid: CARD });

    assert.equal(result.outcome, 'recorded');
    assert.equal(result.challenged, true);
    const row = rowFor('stu-form3b-001');
    assert.equal(row.capture_method, 'fingerprint');
    assert.equal(row.verified, 1);

    const challenge = db.prepare('SELECT * FROM fingerprint_challenges').get();
    assert.equal(challenge.result, 'match');
    assert.equal(challenge.event_id, row.event_id);
  });

  test('challenge + no match: scan rejected, nothing written to attendance_events', () => {
    const handle = createCardHandler({ db, challengeRate: 1, successRate: 0 });
    const result = handle({ cardUid: CARD });

    assert.equal(result.outcome, 'rejected');
    assert.equal(countAttendance(), 0);

    const challenge = db.prepare('SELECT * FROM fingerprint_challenges').get();
    assert.equal(challenge.result, 'no_match');
    assert.equal(challenge.event_id, null);
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='attendance.rejected'").get().n,
      1
    );
  });

  test('second scan of the same student the same day is a duplicate, only one row', () => {
    const handle = createCardHandler({ db, challengeRate: 0 });
    handle({ cardUid: CARD });
    const again = handle({ cardUid: CARD });

    assert.equal(again.outcome, 'duplicate');
    assert.equal(countAttendance(), 1);
  });

  test('unknown card: no write, audited', () => {
    const handle = createCardHandler({ db, challengeRate: 0 });
    const result = handle({ cardUid: 'DEADBEEF' });

    assert.equal(result.outcome, 'unknown-card');
    assert.equal(countAttendance(), 0);
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='rfid.unknown_card'").get().n,
      1
    );
  });

  test('a full sweep of the class writes one record per student', () => {
    const handle = createCardHandler({ db, challengeRate: 0 });
    const cards = db.prepare('SELECT card_uid FROM rfid_cards').all().map((r) => r.card_uid);
    for (const cardUid of cards) handle({ cardUid });
    assert.equal(countAttendance(), 10);
  });

  test('fingerprint challenge fires on roughly 1 in 4 scans', () => {
    const handle = createCardHandler({ db, challengeRate: 0.25, successRate: 1 });
    const n = 600;
    // Alternating two students so ~half are fresh writes and ~half duplicates;
    // every *challenged* scan logs a fingerprint_challenges row regardless.
    for (let i = 0; i < n; i++) handle({ cardUid: i % 2 ? CARD : CARD_2 });

    const challenges = db.prepare('SELECT COUNT(*) n FROM fingerprint_challenges').get().n;
    const rate = challenges / n;
    assert.ok(rate > 0.17 && rate < 0.33, `expected ~0.25, got ${rate.toFixed(3)} (${challenges}/${n})`);
  });
});
