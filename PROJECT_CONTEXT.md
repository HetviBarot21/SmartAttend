# SmartAttend AI — project context

> Hand this to Claude at the start of a session so it knows what already exists.
> Last compiled: 2026-09-08 from the `hetvi/tier1-pwa` branch.

---

## 1. What the product is

Offline-first student **attendance capture + absence-risk** system for
low-connectivity schools in Nairobi, Kenya. A teacher marks a roll call on a
cheap Android phone with no signal; records persist locally and sync to the
cloud when a connection returns; an ML model flags students at risk of
persistent absenteeism so staff can follow up.

**Three tiers + a cloud folder:**

| Dir | Tier | Stack | State |
|---|---|---|---|
| `client/` | Tier 1 — teacher PWA | React 19, Vite 8, Dexie/IndexedDB, Workbox, Jest | Working, demoable end to end |
| `server/` | Tier 2 — simulated school-gate backend | Node (ESM), Express 4, better-sqlite3, `node --test` | Working, 39 tests pass |
| `ml/` | ML pipeline | Python 3, scikit-learn, pandas, pytest (venv at `ml/venv`) | Feature pipeline + first training run done; models weak |
| `aws/` | Cloud tier | Node CommonJS Lambdas, DynamoDB, SES, Africa's Talking | Code written, never deployed; runs against DynamoDB Local |

---

## 2. Repo / branch layout

- **`main`** — where the teammate "Benson" pushes (Tier 2 hardware simulation is his).
- **`hetvi/tier1-pwa`** — the active feature branch, ahead of `origin/main`. All
  Tier 1 PWA work, the ML pipeline, the cloud-sync pipeline, and the training
  script live here. **Merge `main` in when Benson pushes.** The first merge
  (2026-09-04) collided badly on the server — resolved by taking Benson's server
  wholesale (`-X theirs`) and re-porting the sync pipeline onto it.

### Commit history (this branch)
```
425803a feat(server): port cloud-sync pipeline onto Tier 2 backend
a8367a9 Merge branch 'main' into hetvi/tier1-pwa
ae364b1 feat: AWS cloud sync pipeline (server route + worker, Lambdas, PWA queue)
0cde25e feat(ml): feature engineering pipeline for absenteeism risk model
0ad1e65 Tier 2 backend - RFID + fingerprint capture simulation   (Benson, via main)
4000447 feat(client): Tier 1 offline-first PWA - attendance capture, summary, sync badge
7c4e4a6 feat: initial repository structure
```

### Uncommitted working-tree state (as of this doc)
- **Modified:** `client/src/main.jsx`, `client/src/sw/register.js`,
  `client/src/sw/sw.js`, `client/src/workers/syncQueue.js`, `client/vite.config.js`
- **Untracked:** `client/src/services/` (the whole sync-drain service +
  its test), `ml/training/train.py`, `ml/.gitignore`, `ml/data/` (cached
  pickles), `ml/results/evaluation_report.json`,
  `SCH-01_attendance_data_2017-2024.xlsx`, `SCH-02_attendance_data_2017-2024.xlsx`
- i.e. **the Tier 1 sync-drain work and the ML training script are done but not
  yet committed.**

---

## 3. File structure (source only — node_modules / venv / dist omitted)

```
SmartAttend/
├── PROJECT_CONTEXT.md          ← this file
├── SCH-01_attendance_data_2017-2024.xlsx   (raw training data, untracked, ~gitignored intent)
├── SCH-02_attendance_data_2017-2024.xlsx
├── docs/
│   ├── README.md               (stub)
│   └── schema.md               (full description of the Tier 2 SQLite schema)
│
├── client/                     TIER 1 — React PWA
│   ├── index.html
│   ├── vite.config.js          VitePWA injectManifest; dev proxy /api → :3000; global→globalThis shim
│   ├── jest.config.cjs, babel.config.cjs, jest.setup.cjs, eslint.config.js
│   ├── public/                 favicon.svg, icons.svg
│   └── src/
│       ├── main.jsx            mounts App, registers SW, calls startSyncOnReconnect()
│       ├── App.jsx             AuthProvider → AuthGate → TeacherApp (Roll call / Dashboard tabs)
│       ├── App.css, index.css
│       ├── auth/
│       │   ├── AuthContext.jsx status machine: loading / signedOut / locked / ready
│       │   ├── cognito.js      Cognito sign-in with LOCAL fallback session when no pool configured
│       │   └── pin.js          offline 4-digit PIN (bcryptjs), 3 attempts → 15-min lockout, counters in IndexedDB
│       ├── components/
│       │   ├── LoginScreen.jsx
│       │   ├── PinSetup.jsx    offered once per sign-in, skippable
│       │   ├── PinUnlock.jsx   shown when session expired offline
│       │   ├── AttendanceForm.jsx   roll call; "mark all present"; batch submit; dev-only duplicate-check button
│       │   └── Dashboard.jsx   today's present/late/absent/rate, meter bar, "absent today" list, class roll
│       ├── db/
│       │   ├── database.js     Dexie schema v2; addAttendanceEvent/Batch, getStudentsByClass, countPendingSync, etc.
│       │   ├── database.test.js
│       │   └── seedData.js     DEMO_CLASS (class-form3b-001) + 10 fixed students (stu-form3b-001..010)
│       ├── hooks/
│       │   └── useOnlineStatus.js
│       ├── lib/
│       │   └── attendanceSummary.js   pure aggregation (no React/Dexie) — reused by dashboard, later by risk worker
│       ├── services/           ← UNTRACKED
│       │   ├── syncService.js  drainSyncQueue() — the outbound drain half of the Tier 1 sync loop
│       │   └── syncService.test.js
│       ├── sw/
│       │   ├── sw.js           custom service worker (injectManifest): precache + NetworkFirst API GET + sync queue
│       │   └── register.js     registers SW in prod; UNREGISTERS any stale SW in dev
│       ├── workers/
│       │   └── syncQueue.js    Workbox BackgroundSyncPlugin + custom onSync replay + durable-queue sync tag
│       └── pages/              (empty)
│
├── server/                     TIER 2 — Express + SQLite (ESM)
│   ├── .env.example            all vars optional; defaults in src/config.js
│   └── src/
│       ├── server.js           entry: getDb→seed→createApp→listen; spawns syncWorker Worker; runs RfidEmitter
│       ├── app.js              createApp({db}) DI; GET /health /api/students /api/attendance /api/challenges
│       │                        /api/stats; POST /api/rfid/scan; mounts createSyncRouter at /api/sync
│       ├── config.js           env-driven config incl. a `sync` section
│       ├── db/
│       │   ├── index.js        openDatabase(path) applies schema.sql; getDb() singleton
│       │   ├── schema.sql      8 tables (see §6)
│       │   ├── init.js, seed.js, repository.js (+ repository.test.js)
│       ├── routes/
│       │   └── sync.js         createSyncRouter({db}) — POST /api/sync ingest (+ sync.test.js)
│       ├── attendance/
│       │   └── handler.js      createCardHandler — card UID → student → (maybe fingerprint) → attendance row (+ test)
│       ├── simulation/
│       │   ├── rfidEmitter.js  emits 'card-detected' every RFID_INTERVAL_MS (+ test)
│       │   └── fingerprintSimulator.js   probabilistic match (+ test)
│       ├── workers/
│       │   └── syncWorker.js   worker_threads loop: drains sync_queue → POSTs to AWS → backoff/park (+ test)
│       ├── schemas/
│       │   └── attendanceSync.schema.js   JSON schema for the POST /api/sync batch
│       └── lib/
│           ├── validate.js     Ajv wrapper
│           └── random.js
│
├── ml/                         PYTHON ML PIPELINE (venv at ml/venv)
│   ├── README.md, requirements.txt   ← both empty stubs (TODO)
│   ├── .gitignore              ← UNTRACKED; ignores data/*.pkl, models/*.pkl; keeps results/*.json
│   ├── conftest.py             puts ml/training on sys.path for pytest
│   ├── training/
│   │   ├── feature_engineering.py   SchoolCalendar, compute_features(), compute_features_frame()
│   │   ├── compute_labels.py        compute_label(), absence_rate_in_window(), build_training_table()
│   │   ├── temporal_split.py        temporal_train_test_split(), ForwardChainingCV
│   │   ├── kenya_calendar.json      2026 term dates + holidays (NOT used by train.py — data is 2017-2024)
│   │   └── train.py            ← UNTRACKED; orchestrates load→label→split→train 3 models→report
│   ├── tests/test_features.py  33 pytest tests pass
│   ├── data/                   ← UNTRACKED; cached supervised_*.pkl (gitignored)
│   ├── models/                 rf_model.pkl (~80MB, gitignored)
│   └── results/evaluation_report.json   ← UNTRACKED but meant to be versioned
│
└── aws/                        CLOUD TIER — Lambdas (CommonJS)
    ├── README.md               DynamoDB Local setup + go-live steps
    ├── package.json, fixtures/sync-event.json
    └── lambda/
        ├── syncHandler.js          API Gateway POST /sync → validate/dedupe/BatchWrite → DynamoDB + audit
        ├── notificationHandler.js   scan risk_scores for flagLevel=red → SMS parent (Africa's Talking) + email teacher (SES)
        └── lib/
            ├── dynamo.js            DocumentClient factory; LOCAL mode when AWS_ACCESS_KEY_ID unset/placeholder
            └── attendanceSync.schema.js   self-contained copy of the server schema
```

---

## 4. Tier 1 (client) — how it works

> **2026-09-08 UI rebuild (uncommitted).** The PWA was rebuilt to match 5 wireframe
> screens: slate/indigo theme, a bottom nav (Attendance / Heatmap / Alerts) plus a
> Student Profile drill-down. New: `components/` (BottomNav, TopBar, AccountSheet,
> Avatar, Heatmap, Alerts, StudentProfile, icons), `lib/riskModel.js` (a JS port of
> the ML `RuleBasedScorer`), `lib/heatmap.js`, `db/seedData.js` `seedDemoHistory()`.
> `Dashboard.jsx` deleted. `index.css` fully rewritten. 38 Jest tests pass. The
> auth / Dexie / sync internals below are unchanged.

- **Auth:** `AuthContext` is a 4-state machine — `loading → signedOut → locked → ready`.
  - `cognito.js` talks to Amazon Cognito **if** `VITE_COGNITO_USER_POOL_ID` +
    `VITE_COGNITO_CLIENT_ID` are set; otherwise it mints a `mode:'local'` session
    so the PWA is demoable before the pool exists (Sprint 2). Local/PIN sessions
    are never accepted by the AWS authoriser.
  - `pin.js` — offline 4-digit PIN, bcrypt-hashed, enrolled only after an online
    login. 3 wrong attempts → 15-min lockout; counters persisted in IndexedDB so
    a reload doesn't reset them.
  - Dev-only "Simulate session expiry" button backdates the token to show the
    PIN-unlock path without waiting an hour.
- **Data layer:** `db/database.js`, Dexie DB `SmartAttendDB`, **schema v2**.
  - `attendanceEvents`: `&[studentId+date]` (UNIQUE — DB-enforced duplicate
    prevention) and `&eventId` (UNIQUE — the sync idempotency key).
  - `addAttendanceEvent()` writes the event + a `syncQueue` row
    (`status:'pending'`) + an `auditLog` row in **one transaction**.
  - Statuses: `present` / `absent` / `late`. `present`+`late` count as attendance.
  - Dates stored as `YYYY-MM-DD` local (`todayISO()` avoids the UTC shift).
- **Sync — two cooperating queues:**
  1. **Durable Dexie queue** (`syncQueue` table) — the source of truth the
     teacher sees ("N records awaiting sync"). Drained by
     **`services/syncService.js` → `drainSyncQueue()`**: reads pending/failed
     rows, joins each to its `attendanceEvents` row, POSTs batches of 100 to
     `/api/sync`, marks rows `synced` (stamps `attendanceEvents.syncedAt`) or
     `failed` (with `attemptCount++`, `nextAttemptAt = now + backoffMs(n)`,
     `lastError`). `backoffMs(n) = min(30 min, 60 000 · 2^(n-1))`. Module-level
     `inFlight` guard collapses concurrent triggers. Terminal server skip
     reasons (`duplicate_*`, `unknown_student`) → treated as `synced`; only
     `insert_error` retries.
  2. **Workbox Background Sync queue** (`workers/syncQueue.js`) — a
     transport-level net for POSTs that were already in flight when the network
     dropped. Its `onSync` replays queued requests **then** calls
     `drainSyncQueue()`. `registerDurableQueueSync()` adds a dedicated `sync`
     listener for the `smartattend-drain-sync` tag, because Workbox only
     registers a sync event when a request actually failed into its queue — a
     device that only ever recorded offline needs the explicit tag.
  - `startSyncOnReconnect()` (from `main.jsx`) fires on `online` and once at
    launch. `requestBackgroundSync()` prefers the Background Sync API, falls back
    to `postMessage` to the SW, then to a direct in-page drain.
- **Service worker:** custom (`src/sw/sw.js`), `injectManifest` strategy so the
  queue code can live in the worker. `register.js` **unregisters** any stale SW
  when `import.meta.env.DEV` (a leftover SW from a prior `vite build`/`preview`
  otherwise intercepts `/api` and breaks the dev proxy).
- **UI:** single demo class (`class-form3b-001`, "Form 3 B", 10 students). Two
  tabs — Roll call (`AttendanceForm`) and Dashboard.
- **Tests:** Jest. ~24 passing (16 before the sync-drain work + 8 in
  `syncService.test.js`). `npm test` in `client/`.

### Known client issues
- `src/sw/sw.js` + `src/workers/syncQueue.js` line 1 `/* eslint-env serviceworker */`
  → eslint 10 error "no longer supported". Pre-existing, not from the sync work.
- Dev gotcha: a stale SW stuck in the browser intercepts `/api`. Fix = unregister
  SW + delete Cache Storage only. **Do NOT "Clear site data"** — that wipes the
  IndexedDB sync queue.
- All client sync URLs are **relative** (`/api/sync`). Never hardcode a host —
  the Vite dev proxy forwards `/api` to `http://localhost:3000`.

---

## 5. Tier 2 (server) — how it works

- **ESM** Node, `type: "module"`. Entry `src/server.js`. `createApp({db})` uses
  dependency injection so tests pass `:memory:` DBs.
- **RFID/fingerprint simulation** (Benson's): `RfidEmitter` fires a fake card
  scan every 5 s; `handler.js` resolves card UID → student, challenges ~25% for a
  fingerprint, writes `attendance_events` (`capture_method` `rfid`/`fingerprint`,
  `source='simulation'`). A `no_match` writes nothing — just a
  `fingerprint_challenges` row + audit (the buddy-punching trail).
- **Inbound sync:** `POST /api/sync` (`routes/sync.js`). Validates the whole
  batch against `schemas/attendanceSync.schema.js`; dedupes each record on
  `eventId` and on `(studentId, date)`; survivors → `attendance_events`
  (`source='client'`) + `sync_queue` (with a `payload` JSON snapshot), one
  transaction each. Responds 200 `{received, insertedCount, skippedCount,
  inserted, skipped}`. Skip reasons: `duplicate_event_id`,
  `duplicate_student_date`, `unknown_student` (FK fail), `duplicate_race`,
  `insert_error`.
- **Outbound sync:** `workers/syncWorker.js` — a `worker_threads` Worker spawned
  by `server.js`. Every `SYNC_POLL_INTERVAL_MS` (30 s) it drains `pending`
  `sync_queue` rows, POSTs batches of 50 to `SYNC_API_GATEWAY_URL`, marks
  confirmed rows `synced` + stamps `attendance_events.synced_at`. Retryable
  failures (network/429/5xx) → exponential backoff `min(1 800 000,
  60 000·2^attempts)`; 4xx → `failed`; `> SYNC_MAX_ATTEMPTS` (12) → `dead`. With
  `SYNC_API_GATEWAY_URL` unset the worker idles.
- **DB location:** SQLite file lives **outside the repo** by default
  (`%LOCALAPPDATA%\smartattend\smartattend.db`) because this checkout is under
  OneDrive, which holds file handles and deadlocks SQLite's WAL. Override with
  `DB_PATH` only if your checkout is not in a syncing folder. `:memory:` in tests.
- **`better-sqlite3` pinned `^13.0.3`** — it ships Node 25 / ABI 141 prebuilds;
  Benson's `^11` does not → "bindings file not found".
- **Tests:** `node --test src/**/*.test.js`, **39 passing**.
  - Agent-shell quirk: `npm test` / `npm install` fail ("'node' is not
    recognized" — npm's spawned cmd.exe lacks node on PATH). Run `node` directly,
    or `export PATH="/c/Program Files/node:$PATH"`. `npm install` needs
    `--ignore-scripts` in the agent shell (better-sqlite3 postinstall). All fine
    in the user's own PowerShell.

### Server HTTP API
| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | status, table count, pending-sync count |
| GET | `/api/students` | seeded roster |
| GET | `/api/attendance?date=YYYY-MM-DD` | records for a date |
| GET | `/api/challenges?limit=50` | recent fingerprint challenges |
| GET | `/api/stats?date=` | counts by capture method, challenge outcomes, pending sync |
| POST | `/api/rfid/scan` | fire one scan — body `{ "cardUid": "04A1B2C3" }` |
| POST | `/api/sync` | inbound attendance batch from the PWA |

### Quick start
```
cd server && npm install && npm run db:reset && npm start   # :3000, simulation running
```

---

## 6. Tier 2 SQLite schema (8 tables) — `server/src/db/schema.sql`

`PRAGMA foreign_keys = ON`, snake_case, real FKs, CHECK'd enums, dates as
`YYYY-MM-DD` text.

1. **`schools`** — `school_id` PK, name, county
2. **`class_groups`** — `class_group_id` PK, `school_id` FK, grade, stream, academic_year
3. **`students`** — `student_id` PK, `class_group_id` FK, admission_no, full_name, enrolled_at, active
   - Risk-scoring context columns (fee status, repetition, guardian, distance)
     deliberately **not here yet** — added when ML integration starts.
4. **`rfid_cards`** — `card_uid` PK, `student_id` FK; partial unique index enforces
   one active card per student
5. **`attendance_events`** — append-only log. `id` PK; `event_id` **UNIQUE**
   (device idempotency key); `student_id` FK; `date`; `status`
   (present/absent/late); `capture_method` (manual/rfid/fingerprint/import);
   `verified` 0/1; `recorded_by`; `source` (simulation/client/manual);
   `created_at`; `synced_at` (set by syncWorker). **`UNIQUE(student_id, date)`**.
6. **`fingerprint_challenges`** — every biometric challenge; `no_match` +
   `event_id IS NULL` = rejected scan
7. **`sync_queue`** — one row per event to ship to AWS. `event_id` UNIQUE FK;
   `payload` (JSON snapshot, NULL for legacy rows → worker rebuilds); `status`
   (pending/synced/failed/dead); `attempt_count`; `next_attempt_at`; `last_error`
8. **`audit_log`** — action / actor_id / record_id / detail(JSON) / timestamp

### Client Dexie ↔ server SQLite mapping
| client (Dexie) | server (SQLite) |
|---|---|
| `students`, `classGroups` | `students`, `class_groups` (+ `schools`) |
| `attendanceEvents` | `attendance_events` |
| `syncQueue` | `sync_queue` |
| `auditLog` | `audit_log` |
| `riskScores` | *deferred* |
| — | `rfid_cards`, `fingerprint_challenges` |
| `pinCredentials`, `authState` | *client-only (offline auth)* |

The two rosters use **identical IDs** (`school-kibera-001`, `class-form3b-001`,
`stu-form3b-001…010`) so simulated and teacher-entered records reconcile.

---

## 7. ML pipeline (`ml/`)

**Target:** Random Forest classifier predicting **persistent absenteeism** =
student missing ≥ 30 % of scheduled school days in a rolling 4-week window.

**7 features** (`FEATURE_NAMES`): `attendance_rate_w1`, `attendance_rate_w2`,
`attendance_rate_w3` (three consecutive 14-day windows back from `as_of`, school
days only), `longest_absence_streak`, `absence_episode_count` (current 4-week
window), `dow_concentration` (absences on the most-common absence weekday ÷ total
absences), `attendance_trend` (= w1 − w2).

**Conventions:** windows are calendar-time counting only school days; half-open
`[start, as_of)` so no same-day/future leakage; label window `[as_of,
as_of+28d)`. Missing record on a scheduled school day = absent. Attendance rate
is NaN only when a window has zero school days.

**Pipeline modules (`ml/training/`):**
- `feature_engineering.py` — `SchoolCalendar`, `compute_features()`, `compute_features_frame()`
- `compute_labels.py` — `compute_label()`, `absence_rate_in_window()`, `build_training_table(events, calendar, step_days=14)`
- `temporal_split.py` — `temporal_train_test_split(df, test_size|cutoff, gap)` (no shuffle), `ForwardChainingCV` (expanding-window, sklearn-compatible)
- `kenya_calendar.json` — 2026 term dates; **not used by train.py** (data is 2017-2024; per-school calendar built from the xlsx `School Calendar` sheet instead)

**`train.py`** (untracked, added 2026-09-04): loads `SCH-01`/`SCH-02` xlsx,
normalises ~14 status spellings, builds a per-school calendar,
`build_training_table`, temporal-splits SCH-01 (`gap=28`), holds SCH-02 out
whole, trains **RF + LogReg + rule-based**, writes `ml/models/rf_model.pkl`
(~80 MB, gitignored) + `ml/results/evaluation_report.json`.
- Supervised table cached to `ml/data/supervised_*.pkl`; build is **slow
  (~19 min total)** — pure-Python feature computation. `--rebuild` forces,
  `--max-students N` for a dry run.
- `_drop_out_of_enrolment` drops samples where `as_of` is outside a student's
  `[first record, last record] ± 14 d` (kills spurious all-absent windows).
- RF + LogReg wrapped in a `Pipeline` with `SimpleImputer(median)` (sklearn RF
  rejects NaN); `class_weight="balanced"`.
- Needs `openpyxl` + `joblib` (installed in venv, **not in a requirements file**).

**First full-run results (seed 42, SCH-01 split @ 2023-05-03):**

| model | eval set | P | R | F1 | AUC |
|---|---|---|---|---|---|
| RF | SCH-01 test | .377 | .576 | .456 | .674 |
| RF | SCH-02 holdout | .377 | .548 | .446 | .729 |
| LogReg | SCH-01 test | .386 | .591 | .467 | .685 |
| LogReg | SCH-02 holdout | .402 | .564 | .469 | .752 |
| Rule | SCH-01 test | .427 | .296 | .350 | .628 |
| Rule | SCH-02 holdout | .446 | .278 | .342 | .672 |

**Models are weak.** LogReg beats RF on every metric (RF likely needs tuning, or
the 7 features are near-linear + collinear — w1/w2/w3 are all attendance rates).
Precision ~0.38 ≈ 2.7 false positives per true positive (`class_weight` favours
recall). RF importance: `attendance_rate_w3` (.27) > w1 (.19) > w2 (.15).

**Run tests:** `cd ml && ./venv/Scripts/python.exe -m pytest tests/ -q` — 33 pass.
**Run training:** `cd ml && ./venv/Scripts/python.exe training/train.py`

---

## 8. AWS cloud tier (`aws/`) — written, never deployed

Flow: PWA → Workbox queue → `POST /api/sync` (Tier 2) → SQLite `sync_queue` →
`syncWorker` → **API Gateway → `syncHandler` Lambda → DynamoDB**.

- **`syncHandler.js`** — API Gateway proxy; Ajv validate; dedupe via DynamoDB
  BatchGet on `eventId`; BatchWrite new records (25-chunk, UnprocessedItems
  retry); one audit BatchWrite per record.
- **`notificationHandler.js`** — Scan `RISK_SCORES_TABLE` for `flagLevel='red'`
  (+ `attribute_not_exists(notifiedAt)`); SMS parent via Africa's Talking; email
  teacher via SES (student name / attendance rate / risk score / top-3
  features); stamps `notifiedAt`.
- **`lib/dynamo.js`** — **local mode** when `AWS_ACCESS_KEY_ID` unset or
  `'placeholder'` → DynamoDB Local at `DYNAMODB_ENDPOINT`; `notificationHandler`
  also dry-runs (logs) SMS/email in that mode.
- Env: real creds not set (`AWS_ACCESS_KEY_ID=placeholder`). Go-live steps in
  `aws/README.md` (SES not in `af-south-1`; needs an execution role; bundle
  `ajv`+`ajv-formats`).

**Not built (wiring left):** a local API-Gateway shim to run `syncHandler`
against `SYNC_API_GATEWAY_URL`; DynamoDB `notifiedAt` needs an SK-less table or a
key adjustment.

---

## 9. Sprint status & what's next

**Done:** Phase 0, Sprint 1 (PWA attendance capture + offline auth), ML feature
engineering, cloud-sync pipeline (both halves) + merge with Tier 2, ML model
training first pass, Tier 1 outbound sync-drain (`syncService.js`).

**Pending / next:**
- Commit the untracked Tier 1 sync-drain + ML training work.
- RF hyperparameter tuning (`ForwardChainingCV` was built for this) + decision-
  threshold tuning for precision; richer features (raw counts, longer history,
  `Absence Reasons` fees-vs-illness, profile fields, term-boundary proximity).
- **Risk engine in a client Web Worker** — will reuse `client/src/lib/attendanceSummary.js`
  (kept React/Dexie-free for exactly this). Populates the Dexie `riskScores`
  table; Dashboard's "Absent today" list becomes risk-scored amber/red flags (US-02).
- `ml/requirements.txt` + `ml/README.md` are empty stubs — fill them.
- Local API-Gateway shim around `aws/lambda/syncHandler.js`.
- Islamic Idd holidays missing from `kenya_calendar.json`.
- Real Cognito user pool (Sprint 2) + real AWS deployment.

---

## 10. Working-style notes (from the user)

- The user provides **detailed written specs** and wants them built directly.
  When they say "what's next / next sprint", they'll paste a full spec in the
  next message — **don't stop to ask multiple-choice scope questions.** Surface
  assumptions briefly in prose, then proceed with sensible defaults.
- Platform: **Windows 11, PowerShell**. Project lives under
  `OneDrive/Desktop/SmartAttend` (hence the deliberate out-of-repo SQLite file).
- Git author on this branch: `hetvi`.
