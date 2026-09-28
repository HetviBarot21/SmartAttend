-- SmartAttend AI Tier 2 schema (SQLite). Mirrors the client's Dexie database.
-- Unique constraints on event_id and (student_id, date) block duplicate records.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schools (
  school_id   TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  county      TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS class_groups (
  class_group_id TEXT PRIMARY KEY,
  school_id      TEXT NOT NULL REFERENCES schools(school_id) ON DELETE CASCADE,
  grade          TEXT NOT NULL,
  stream         TEXT,
  academic_year  INTEGER NOT NULL,
  teacher_name   TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS students (
  student_id     TEXT PRIMARY KEY,
  class_group_id TEXT NOT NULL REFERENCES class_groups(class_group_id) ON DELETE CASCADE,
  admission_no   TEXT NOT NULL,
  full_name      TEXT NOT NULL,
  guardian_phone TEXT,
  guardian_email TEXT,
  enrolled_at    TEXT NOT NULL DEFAULT (date('now')),
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_students_class ON students(class_group_id);

-- A replaced card is kept with active = 0.
CREATE TABLE IF NOT EXISTS rfid_cards (
  card_uid    TEXT PRIMARY KEY,
  student_id  TEXT NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  issued_at   TEXT NOT NULL DEFAULT (datetime('now')),
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_rfid_student ON rfid_cards(student_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rfid_one_active_card
  ON rfid_cards(student_id) WHERE active = 1;

CREATE TABLE IF NOT EXISTS attendance_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id       TEXT NOT NULL UNIQUE,
  student_id     TEXT NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  date           TEXT NOT NULL,                       -- YYYY-MM-DD, school-local
  status         TEXT NOT NULL CHECK (status IN ('present', 'absent', 'late')),
  capture_method TEXT NOT NULL CHECK (capture_method IN ('manual', 'rfid', 'fingerprint', 'import')),
  verified       INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  recorded_by    TEXT,                                -- teacher username, or NULL for hardware
  source         TEXT NOT NULL DEFAULT 'simulation' CHECK (source IN ('simulation', 'client', 'manual')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  synced_at      TEXT,                                -- set by syncWorker once AWS confirms the row
  UNIQUE (student_id, date)
);

CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance_events(date);
CREATE INDEX IF NOT EXISTS idx_attendance_student ON attendance_events(student_id);

-- A 'no_match' row with event_id NULL is a rejected scan.
CREATE TABLE IF NOT EXISTS fingerprint_challenges (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id    TEXT NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  card_uid      TEXT NOT NULL,
  event_id      TEXT REFERENCES attendance_events(event_id) ON DELETE SET NULL,
  result        TEXT NOT NULL CHECK (result IN ('match', 'no_match')),
  success_rate  REAL NOT NULL,                        -- configured rate at challenge time
  challenged_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_challenge_student ON fingerprint_challenges(student_id);

-- Outbound queue to AWS. next_attempt_at NULL means due now. 'dead' means
-- SYNC_MAX_ATTEMPTS ran out; 'failed' means AWS rejected the payload.
CREATE TABLE IF NOT EXISTS sync_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        TEXT NOT NULL UNIQUE REFERENCES attendance_events(event_id) ON DELETE CASCADE,
  payload         TEXT,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'synced', 'failed', 'dead')),
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_attempt_at TEXT,
  synced_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_status ON sync_queue(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  action     TEXT NOT NULL,
  actor_id   TEXT,
  record_id  TEXT,
  detail     TEXT,                                    -- JSON string
  timestamp  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);

-- One row per contact attempt about a flagged student.
CREATE TABLE IF NOT EXISTS follow_ups (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id   TEXT NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  flag         TEXT NOT NULL CHECK (flag IN ('amber', 'red')),
  method       TEXT NOT NULL CHECK (method IN ('parent_call', 'sms', 'home_visit', 'meeting', 'other')),
  note         TEXT,
  actor        TEXT,                                  -- teacher/admin username
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_followups_student ON follow_ups(student_id, created_at);
