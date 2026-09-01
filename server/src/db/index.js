'use strict';

/**
 * SQLite connection + schema for the Tier 2 simulated backend.
 *
 * better-sqlite3 is synchronous, which is exactly what we want here: the sync
 * route and the sync worker both run short transactions and synchronous code is
 * simpler to reason about than a pool of async queries. One process opens one
 * database file (WAL mode so the worker thread and the HTTP server can read/write
 * concurrently).
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH =
  process.env.SQLITE_PATH || path.join(__dirname, '..', '..', 'data', 'smartattend.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// The HTTP server and the sync worker thread each open this file; give a
// blocked writer a few seconds to get the lock instead of throwing SQLITE_BUSY.
db.pragma('busy_timeout = 5000');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS attendance_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id       TEXT NOT NULL UNIQUE,          -- device-generated idempotency key
  student_id     TEXT NOT NULL,
  date           TEXT NOT NULL,                 -- YYYY-MM-DD, local school day
  status         TEXT NOT NULL CHECK (status IN ('present', 'absent', 'late')),
  capture_method TEXT NOT NULL DEFAULT 'manual',
  recorded_by    TEXT,
  created_at     TEXT NOT NULL,                 -- when the device recorded it
  received_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  synced_at      TEXT,                          -- when this row was pushed to AWS
  UNIQUE (student_id, date)
);
CREATE INDEX IF NOT EXISTS idx_attendance_synced ON attendance_events (synced_at);

-- Outbound queue: rows waiting to be pushed to the AWS cloud by syncWorker.js.
CREATE TABLE IF NOT EXISTS sync_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        TEXT NOT NULL UNIQUE,
  payload         TEXT NOT NULL,                -- JSON of the attendance record
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'synced', 'failed', 'dead')),
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,                         -- ISO; NULL means "eligible now"
  last_error      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  synced_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_queue_status ON sync_queue (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  action    TEXT NOT NULL,
  actor_id  TEXT,
  record_id TEXT,
  detail    TEXT,
  timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Written by the Sprint 4 risk engine; read by aws/lambda/notificationHandler.js.
CREATE TABLE IF NOT EXISTS risk_scores (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id      TEXT NOT NULL,
  student_name    TEXT,
  attendance_rate REAL,
  total_score     REAL NOT NULL,
  flag_level      TEXT NOT NULL CHECK (flag_level IN ('green', 'amber', 'red')),
  top_features    TEXT,                         -- JSON: [{feature, contribution}, ...]
  parent_phone    TEXT,
  teacher_email   TEXT,
  calculated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  notified_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_risk_flag ON risk_scores (flag_level, notified_at);
`;

db.exec(SCHEMA);

module.exports = { db, DB_PATH };
