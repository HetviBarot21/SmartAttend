# Server (Tier 2 Simulated Backend)

Express + SQLite backend that stands in for the school gate hardware. A mock RFID
reader fires a card scan every 5 seconds; each scan is turned into an attendance
record in SQLite, and ~1 in 4 scans is challenged for a fingerprint match.

## Requirements

- Node.js 22+ (uses the built-in test runner and `--env-file-if-exists`)
- No global tools. `better-sqlite3` ships prebuilt binaries.
- On Windows, run `npm install` from PowerShell, not Git Bash.

## Quick start

```bash
cd server
npm install
npm run db:reset     # create the SQLite file + seed the demo class
npm start            # server on http://localhost:3000, simulation running
```

You'll see scans in the console:

```
[rfid] Faith Achieng (stu-form3b-004) -> present via rfid
[rfid] Moses Kipchoge (stu-form3b-009) -> present via fingerprint (fingerprint verified)
[rfid] Faith Achieng (stu-form3b-004) -> already recorded today, ignored
```

## Where the database lives

By default the SQLite file is **outside the repo**, at
`%LOCALAPPDATA%\smartattend\smartattend.db` (Windows) or
`$TMPDIR/smartattend/smartattend.db` elsewhere.

This is deliberate: this project is usually checked out under `OneDrive/...`, and
OneDrive holds file handles open to sync changes, which deadlocks SQLite's WAL
files after the first write. If your checkout is **not** under a syncing folder
you can point it back into the repo with `DB_PATH=./data/smartattend.db` in a
`.env` file (see `.env.example`).

## Configuration

All optional - copy `.env.example` to `.env` to override.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `%LOCALAPPDATA%\smartattend\smartattend.db` | SQLite file, or `:memory:` |
| `RFID_INTERVAL_MS` | `5000` | Gap between simulated scans |
| `FINGERPRINT_CHALLENGE_RATE` | `0.25` | Fraction of scans challenged for a fingerprint |
| `FINGERPRINT_SUCCESS_RATE` | `0.9` | Fraction of challenges the mock scanner passes |
| `SIMULATION_ENABLED` | `true` | Set `false` to boot without the RFID loop |
| `SYNC_API_GATEWAY_URL` | *(unset)* | AWS sync Lambda endpoint. Unset → worker idles |
| `SYNC_API_GATEWAY_KEY` | *(unset)* | `x-api-key` sent with each batch |
| `SYNC_POLL_INTERVAL_MS` | `30000` | How often the worker drains `sync_queue` |
| `SYNC_BATCH_SIZE` | `50` | Records per POST |
| `SYNC_BACKOFF_MIN_MS` / `_MAX_MS` | `60000` / `1800000` | Retry backoff bounds |
| `SYNC_MAX_ATTEMPTS` | `12` | Retryable failures before a row is parked `dead` |
| `SYNC_WORKER_DISABLED` | `false` | Set `true` to boot without the sync worker |

## HTTP API

| Method | Path | Description |
|---|---|---|
| GET | `/health` | status, table count, pending-sync count |
| GET | `/api/students` | the seeded roster |
| GET | `/api/attendance?date=YYYY-MM-DD` | attendance records for a date (default today) |
| GET | `/api/challenges?limit=50` | recent fingerprint challenges |
| GET | `/api/stats?date=YYYY-MM-DD` | counts by capture method, challenge outcomes, pending sync |
| POST | `/api/rfid/scan` | fire one scan now - body `{ "cardUid": "04A1B2C3" }` |
| POST | `/api/sync` | inbound attendance batch from the offline PWA (see below) |

Valid `cardUid` values are the 10 seeded cards: `04A1B2C3`, `04D4E5F6`,
`0417A8B9`, `04C2D3E4`, `0455667788`, `04998877`, `04AABBCC`, `04DDEEFF`,
`04123456`, `0478DEF0`.

## How a scan becomes a record

`src/attendance/handler.js`:

1. Resolve the card UID to a student (`rfid_cards` -> `students`). Unknown card -> audit row, stop.
2. With probability `FINGERPRINT_CHALLENGE_RATE`, run the mock fingerprint scan:
   - **match** -> write attendance with `capture_method = 'fingerprint'`, `verified = 1`, and link the challenge row to the event.
   - **no match** -> reject. Nothing is written to `attendance_events`; a `fingerprint_challenges` row with `result = 'no_match'` and an `attendance.rejected` audit row are the buddy-punching trail.
3. No challenge -> write attendance with `capture_method = 'rfid'`, `verified = 0`.
4. A second scan of the same student the same day hits `UNIQUE(student_id, date)` and is reported as a duplicate - no second row.

The attendance write, its `sync_queue` entry and the audit row share one
transaction, so a rejected write leaves nothing behind.

## Sync: PWA → here → AWS

Two halves, both backed by `sync_queue`:

**Inbound** — `POST /api/sync` (`src/routes/sync.js`). The offline PWA posts a
batch `{ deviceId, records: [...] }`; the whole batch is validated against
`src/schemas/attendanceSync.schema.js`. Each record is deduplicated on `eventId`
and on `(studentId, date)` — re-sent records are reported as skipped, not errors,
so the PWA can safely retry whole batches. Survivors land in `attendance_events`
(`source = 'client'`) and `sync_queue`, one transaction each. Responds `200` with
`{ received, insertedCount, skippedCount, inserted, skipped }`.

**Outbound** — `src/workers/syncWorker.js`, spawned as a worker thread by
`server.js` (skip it with `SYNC_WORKER_DISABLED=true`). Every
`SYNC_POLL_INTERVAL_MS` it drains `pending` rows, POSTs them in batches to
`SYNC_API_GATEWAY_URL` (the AWS sync Lambda), marks confirmed rows `synced` and
stamps `attendance_events.synced_at`. Retryable failures (network, 429, 5xx) are
rescheduled with exponential backoff; a 4xx parks the row as `failed`; too many
retries parks it as `dead`. With no `SYNC_API_GATEWAY_URL` set the worker just
idles.

With no real AWS yet, point `SYNC_API_GATEWAY_URL` at a local shim around
`../aws/lambda/syncHandler.js`.

## Schema

8 tables, defined in `src/db/schema.sql` (`CREATE TABLE IF NOT EXISTS`, so it's
safe to run on every boot). Full description in `../docs/schema.md`.

- `schools` -> `class_groups` -> `students` -> `rfid_cards`
- `students` -> `attendance_events` -> `sync_queue` -> (`syncWorker.js`) -> AWS
- `attendance_events` / `students` -> `fingerprint_challenges`
- `audit_log` - standalone (action / actor / record / detail / timestamp)

## Tests

```bash
npm test             # node --test, 39 tests
```

Covers: all 8 tables created, seed correctness, attendance write + atomicity,
duplicate prevention (same student/date, reused `event_id`), capture-method
values, the RFID emitter timing (mocked timers), the fingerprint distribution,
the full scan-to-SQLite handler including the ~25% challenge rate, the
`POST /api/sync` ingest (validation, both dedup paths, mixed batches, unknown
student), and the sync worker's backoff / batching / cloud-response handling.

## Not built yet

- Risk scoring / ML (deferred - schema keeps `attendance_events` append-only so
  the history is there when it's needed)
- Real Cognito-verified requests
- Real AWS: `syncWorker.js` targets `SYNC_API_GATEWAY_URL`; until that's a
  deployed endpoint, point it at a local shim around `../aws/lambda/syncHandler.js`
