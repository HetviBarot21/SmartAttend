-- SmartAttend AI - Tier 2 backend schema (SQLite)
--
-- Fresh server-side schema. It mirrors the concepts in the client's Dexie
-- database (client/src/db/database.js) so records can line up during sync
-- later, but uses SQL conventions (snake_case, real foreign keys, CHECK
-- constraints) and adds the tables the hardware simulation needs.
--
-- Eight tables:
--   schools, class_groups, students        - roster
--   rfid_cards                             - card UID -> student binding
--   attendance_events                      - the append-only attendance log
--   fingerprint_challenges                 - every biometric challenge + outcome
--   sync_queue                             - records waiting to reach AWS, plus the
--                                            outbound retry/backoff state syncWorker.js keeps
--   audit_log                              - who/what/when, for traceability
--
-- Duplicate prevention is enforced by the database, not by application checks:
--   attendance_events.event_id       UNIQUE  - device-generated idempotency key
--   attendance_events(student_id,date) UNIQUE - one record per student per day

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schools (
  school_id   TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  county      TEXT,
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

-- One physical card maps to one student. A student may be re-issued a card, so
-- the old row is kept with active = 0 rather than deleted.
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

-- Every fingerprint challenge the RFID handler raises, whether it passed or not.
-- A 'no_match' row with event_id NULL is a rejected scan - no attendance was
-- written. This is the buddy-punching audit trail.
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

-- Outbound queue: one row per attendance_event that still has to reach AWS.
--   payload          - JSON snapshot POSTed to the sync Lambda (matches
--                      attendanceSync.schema.js). NULL for legacy rows; the
--                      worker rebuilds it from attendance_events in that case.
--   next_attempt_at  - ISO; NULL means "eligible now". Set by the worker's
--                      exponential backoff after a retryable failure.
--   status 'dead'    - retryable failures that exhausted SYNC_MAX_ATTEMPTS.
--   status 'failed'  - the cloud rejected the payload (4xx); a retry won't help.
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

-- One row per time a teacher/admin reaches out about a flagged student. There is
-- no "resolved" workflow - a fresh flag after a gap simply gets a fresh row.
-- getFlaggedStudents() treats a student as "needs follow-up" when their most
-- recent row (if any) is older than FOLLOW_UP_FRESH_DAYS (src/lib/riskModel.js).
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
