# Data model — Tier 2 backend (SQLite)

Canonical definition: `server/src/db/schema.sql`. This document explains it.

The schema is fresh (designed server-side, not generated from the client) but it
deliberately reuses the client's identifiers — `school-kibera-001`,
`class-form3b-001`, `stu-form3b-001…010` — so a record created by the RFID
simulation and a record created by the teacher in the PWA describe the same
student and can be reconciled when sync is built.

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
Contextual columns for risk scoring (fee status, repetition, guardian, distance)
are **not** here yet — they get added when the ML work starts. `attendance_events`
is kept append-only so the history they'd train on is preserved.

### 4. `rfid_cards`
`card_uid` (PK, text — the physical card's UID), `student_id` (FK → students),
`issued_at`, `active` (0/1).
Partial unique index `idx_rfid_one_active_card` enforces **one active card per
student**; a re-issued card keeps the old row with `active = 0`.

### 5. `attendance_events`
The append-only attendance log.

| column | notes |
|---|---|
| `id` | int PK autoincrement |
| `event_id` | text, **UNIQUE** — device-generated idempotency key; matches the client's `eventId` |
| `student_id` | FK → students |
| `date` | `YYYY-MM-DD`, school-local |
| `status` | `present` \| `absent` \| `late` |
| `capture_method` | `manual` \| `rfid` \| `fingerprint` |
| `verified` | 0/1 — 1 when a fingerprint challenge passed |
| `recorded_by` | teacher username, or `NULL` for hardware |
| `source` | `simulation` \| `client` \| `manual` |
| `created_at` | timestamp |

**`UNIQUE (student_id, date)`** — one record per student per day. This is the
duplicate-prevention guarantee; it is enforced by the database, not by
application checks. Together with the unique `event_id` it makes re-delivered
scans safe.

### 6. `fingerprint_challenges`
Every biometric challenge the handler raises, pass or fail.

`id`, `student_id` (FK), `card_uid`, `event_id` (FK → attendance_events.event_id,
**nullable**), `result` (`match` \| `no_match`), `success_rate` (the configured
rate at challenge time), `challenged_at`.

A `no_match` row with `event_id IS NULL` is a **rejected scan** — no attendance
was written. This is the buddy-punching audit trail.

### 7. `sync_queue`
Records waiting to reach the cloud (Tier 3, not built).

`id`, `event_id` (FK → attendance_events, **UNIQUE**), `status`
(`pending` \| `synced` \| `failed`), `attempt_count`, `created_at`,
`last_attempt_at`.

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
| — | `rfid_cards`, `fingerprint_challenges` (hardware simulation) |
| `pinCredentials`, `authState` | *client-only (offline auth)* |
