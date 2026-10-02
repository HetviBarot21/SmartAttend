# Data model: Tier 2 backend (SQLite)

Canonical definition: `server/src/db/schema.sql`. This document explains it.

The schema reuses the client's identifiers (`school-kibera-001`,
`class-form3b-001`, `stu-form3b-001…010`), so a record from the RFID simulation
and one from the PWA refer to the same student.

Conventions: `snake_case`, real `FOREIGN KEY`s (`PRAGMA foreign_keys = ON`),
`CHECK` constraints on enums, timestamps as SQLite `TEXT` (`datetime('now')`),
dates as `TEXT` `YYYY-MM-DD` in school-local time.

## The 8 tables

### 1. `schools`
`school_id` (PK, text), `name`, `county`, `created_at`.
Top of the roster hierarchy.

### 2. `class_groups`
`class_group_id` (PK, text), `school_id` (FK → schools), `grade`, `stream`,
`academic_year` (int), `created_at`.

### 3. `students`
`student_id` (PK, text), `class_group_id` (FK → class_groups), `admission_no`,
`full_name`, `enrolled_at`, `active` (0/1).
`attendance_events` is append-only so the full history is kept.

### 4. `rfid_cards`
`card_uid` (PK, text, the physical card's UID), `student_id` (FK → students),
`issued_at`, `active` (0/1).
Partial unique index `idx_rfid_one_active_card` enforces **one active card per
student**; a re-issued card keeps the old row with `active = 0`.

### 5. `attendance_events`
The append-only attendance log.

| column | notes |
|---|---|
| `id` | int PK autoincrement |
| `event_id` | text, **UNIQUE**. Device-generated idempotency key; matches the client's `eventId` |
| `student_id` | FK → students |
| `date` | `YYYY-MM-DD`, school-local |
| `status` | `present` \| `absent` \| `late` |
| `capture_method` | `manual` \| `rfid` \| `fingerprint` \| `import` |
| `verified` | 1 when a fingerprint challenge passed, else 0 |
| `recorded_by` | teacher username, or `NULL` for hardware |
| `source` | `simulation` \| `client` \| `manual` |
| `reason` | absence reason: `fee` \| `health` \| `other` \| `unknown`, or `NULL` (not given / not absent). `fee` + `health` feed the risk model |
| `created_at` | timestamp |
| `synced_at` | timestamp, set by `syncWorker.js` once AWS confirms the row; `NULL` until then |

**`UNIQUE (student_id, date)`** allows one record per student per day. Together
with the unique `event_id`, the database itself blocks duplicate scans.

### 6. `fingerprint_challenges`
Every biometric challenge the handler raises, pass or fail.

`id`, `student_id` (FK), `card_uid`, `event_id` (FK → attendance_events.event_id,
**nullable**), `result` (`match` \| `no_match`), `success_rate` (the configured
rate at challenge time), `challenged_at`.

A `no_match` row with `event_id IS NULL` is a **rejected scan**: no attendance
was written.

### 7. `sync_queue`
One row per `attendance_event` that still has to reach AWS. Drained by
`server/src/workers/syncWorker.js`.

| column | notes |
|---|---|
| `id` | int PK autoincrement |
| `event_id` | FK → attendance_events, **UNIQUE** |
| `payload` | JSON snapshot POSTed to the sync Lambda (matches `attendanceSync.schema.js`); `NULL` for legacy rows, which the worker rebuilds from `attendance_events` |
| `status` | `pending` \| `synced` \| `failed` (4xx, retrying won't help) \| `dead` (`SYNC_MAX_ATTEMPTS` used up) |
| `attempt_count` | POST attempts made so far |
| `next_attempt_at` | ISO; `NULL` = eligible now. Set by exponential backoff after a retryable failure |
| `last_error` | last failure reason, for debugging |
| `created_at`, `last_attempt_at`, `synced_at` | timestamps |

Written in the same transaction as the attendance row, so it can never reference
a record that isn't there.

### 8. `audit_log`
Standalone traceability log. `id`, `action` (e.g. `attendance.recorded`,
`attendance.rejected`, `rfid.unknown_card`), `actor_id`, `record_id`,
`detail` (JSON text), `timestamp`.

## Relationship to the client's Dexie schema

| client (Dexie) | server (SQLite) |
|---|---|
| `students`, `classGroups` | `students`, `class_groups` (+ `schools`) |
| `attendanceEvents` | `attendance_events` |
| `syncQueue` | `sync_queue` |
| `auditLog` | `audit_log` |
| `riskScores` | *deferred* |
| (none) | `rfid_cards`, `fingerprint_challenges` (hardware simulation) |
| `pinCredentials`, `authState` | *client-only (offline auth)* |
