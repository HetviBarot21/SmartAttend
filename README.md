# SmartAttend AI

Offline-first student attendance for low-connectivity schools in Kenya, with a
machine-learning model that flags students at risk of persistent absenteeism
so staff can follow up early.

A teacher records attendance on a cheap Android phone with no signal. Records
are saved on the phone first and sync when a connection returns. Schools can
add an RFID + fingerprint gate so students check themselves in, and the
teacher only has to deal with whoever did not scan.

## Plans

SmartAttend is one product with an optional add-on:

| | Standard | Premium |
|---|---|---|
| Teacher app (PWA) | Teacher takes the full roll call | Teacher confirms the gate's scans and marks only students who did not scan |
| Gate box (Raspberry Pi + RFID + fingerprint) | — | Students tap in; fingerprint checks stop buddy-punching |
| Risk model, alerts, cloud | Yes | Yes |

**The teacher app is the fallback.** If the gate is down, unreachable or has
no scans yet, the app says so and the teacher takes a normal full roll call.
Attendance is never lost because the gate failed.

## How it fits together

```
 Gate reader ──scans──► Gate box (Tier 2 server, SQLite) ──internet, when up──► Cloud (AWS)
                           ▲                │
          2. push marks    │                │  1. pull today's gate scans
             + reasons     │                ▼     (school Wi-Fi, no internet needed)
                        Teacher's phone (Tier 1 PWA, IndexedDB)
                        teacher confirms, marks absent + reason,
                        saved on the phone first
```

1. When the roll call opens, the phone pulls the class's gate scans for today
   (`GET /api/gate/classes/:id/attendance`). Scanned students show as present
   "at gate".
2. The teacher marks the rest (e.g. absent, with a reason: Fees, Sick, Other,
   Don't know) and confirms. Marks are saved on the phone and pushed to the
   gate box with `POST /api/sync` when it is reachable.
3. The gate box forwards every record to the cloud when it has internet.

If a teacher marked a student absent offline but the student had scanned in,
the gate's record wins and the teacher is told.

## Repository layout

| Folder | What it is | Stack | Details |
|---|---|---|---|
| [`client/`](client/README.md) | Tier 1 — teacher app (installable PWA, works offline) | React 19, Vite, Dexie/IndexedDB, Workbox, Jest | Roll call, heatmap, risk alerts, student profiles, class/roster management, admin views |
| [`server/`](server/README.md) | Tier 2 — gate box backend | Node (ESM), Express, better-sqlite3, `node --test` | Simulated RFID + fingerprint gate, sync endpoint, gate endpoint, admin/roster APIs, risk scoring |
| [`ml/`](ml/README.md) | Absence-risk model | Python, scikit-learn, pandas, pytest | Feature engineering, training, tuning, export of the model to JSON |
| [`aws/`](aws/README.md) | Cloud tier | Node Lambdas, DynamoDB, SES, Africa's Talking | Sync ingest; SMS/email alerts for red-flagged students |
| [`docs/`](docs/) | Reference docs | — | [`schema.md`](docs/schema.md): the server's database tables |

## The risk model

The model predicts whether a student will miss 30% or more of school days in
the next four weeks, from 11 features (recent attendance rates, absence
streaks, weekday patterns, term position, and the share of absences due to
fees or illness). It was trained on 2017–2024 data from two schools.

The trained model is exported to JSON and evaluated in plain JavaScript on the
phone and on the server, so risk flags work fully offline with no Python
service. See [`ml/README.md`](ml/README.md) for features and results.

## Running it locally

You need Node 22+ and, for the ML pipeline, Python 3.11. On Windows run
`npm install` from PowerShell, not Git Bash.

Start the gate server first, then the teacher app, in two terminals:

```powershell
# 1. Gate server on http://localhost:3000 - seeds a demo class and runs the simulated gate
cd server
npm install
npm run db:reset   # WARNING: wipes and re-seeds the local database
npm start

# 2. Teacher app on http://localhost:5173 - /api is proxied to the server
cd client
npm install
npm run dev
```

Open http://localhost:5173, sign in (local mode needs no AWS account) and
open the **Form 3 B** demo class. The simulated gate taps a card every 5
seconds, so the banner shows how many students scanned in, and the rest can be
marked with a reason.

The server's database lives outside the repo
(`%LOCALAPPDATA%\smartattend\smartattend.db`) because OneDrive locks SQLite's
files. Settings are in [`server/.env.example`](server/.env.example).

Docker: `docker compose up` runs the server only.

## Tests

| Part | Command | |
|---|---|---|
| Server | `cd server && npm test` | 79 tests |
| Teacher app | `cd client && npm test` | 104 tests |
| ML | `cd ml && ./venv/Scripts/python.exe -m pytest tests/ -q` | see `ml/README.md` |

GitHub Actions runs all three on every push to `main` and on pull requests
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## Status

Working and demoable: the teacher app, the simulated gate server, the gate ↔
teacher link with absence reasons, and the risk model inside both.

Not done yet:

- Login is local-only; the server's API has no authentication yet (AWS Cognito planned).
- The cloud tier is written but not deployed.
- The gate is simulated; real Raspberry Pi, RFID reader and fingerprint drivers are still to come.
- Absence reasons are recorded but not yet used in the risk score (the fee and illness features are still 0).
- Schools without a gate see a "can't reach the school gate" notice; this should follow the school's plan.
