# Client (Tier 1 Offline-First PWA)

React 19 + Vite installable PWA that a teacher uses to take attendance from a
phone or tablet with no reliable connectivity. Local PIN auth, an offline
roster/attendance store in IndexedDB, and a background sync queue that drains
to the Tier 2 server (`../server`) once the device is back online.

## Requirements

- Node.js 22+
- On Windows, run `npm install` from PowerShell, not Git Bash (see
  `../server/README.md` for why).

## Quick start

```bash
cd client
npm install
npm run dev        # http://localhost:5173, /api/* proxied to Tier 2 on :3000
```

Start `../server` first (`npm start` there). The dev server proxies `/api/*` to
`http://localhost:3000` (`vite.config.js`). Without it the app still works
offline, and sync attempts stay queued.

## Roles

Chosen at sign-up (`components/LoginScreen.jsx`), stored on the session:

| Role | Screen(s) | What they see |
|---|---|---|
| `teacher` | Attendance / Heatmap / Alerts / Student Profile | Their own class(es), full attendance editing |
| `admin` (school admin) | Overview + read-only class drill-down | Every class/teacher in their school, cross-class flagged students, follow-up logging (`components/AdminOverview.jsx`) |
| `system_admin` | System Admin | Every school on the platform, activate/deactivate (`components/SystemAdminOverview.jsx`). Skips class setup and the offline PIN |

## Configuration

No `.env` is required for local development (see **Local authentication
mode** below). Two optional Vite env vars switch auth to real AWS Cognito:

| Variable | Default | Meaning |
|---|---|---|
| `VITE_COGNITO_USER_POOL_ID` | *(unset)* | Cognito user pool ID |
| `VITE_COGNITO_CLIENT_ID` | *(unset)* | Cognito app client ID |

### Local authentication mode

With neither Cognito variable set (the default), `auth/cognito.js` creates a
device-local session for any email and password, with no credential check.
Sign-up stores a display name, role and (for `admin`) a school name in
IndexedDB. See `../PROJECT_CONTEXT.md` for the plan to move to Cognito.

## What's in `src/`

- `auth/`: `cognito.js` (local-mode/Cognito auth), `pin.js` (offline PIN,
  hashed with `bcryptjs`), `AuthContext.jsx`
- `db/database.js`: the Dexie (IndexedDB) schema: classes, students, roster,
  attendance, `syncQueue`, `rosterSyncQueue`, `riskScores`, `followUps`
- `components/`: screens: `AttendanceForm`, `Heatmap`, `Alerts`,
  `StudentProfile`, `RosterManager`, `SetupWizard` (first-run onboarding),
  `AdminOverview` / `AdminClassDetail`, `SystemAdminOverview`
- `services/`: `syncService.js` (outbound attendance sync),
  `rosterSyncService.js` (outbound roster sync), `adminService.js` /
  `systemAdminService.js` (live fetches from the server)
- `lib/`: `riskModel.js` (the trained ML model plus the rule-based scorer),
  `heatmap.js`, `attendanceSummary.js`
- `sw/sw.js`: custom service worker (offline app shell and Workbox Background Sync)

## Sync: here → Tier 2 → AWS

Outbound only from this side. `services/syncService.js` /
`rosterSyncService.js` drain `syncQueue` / `rosterSyncQueue` (populated by
every attendance write / roster edit in `db/database.js`) via
`POST /api/sync` and the `/api/roster/*` upserts, triggered on reconnect
(`hooks/useOnlineStatus.js`) and via the service worker's Background Sync.
See `../server/README.md` for the rest of the path to AWS.

## Tests

```bash
npm test             # jest
npm run lint         # eslint
```

Covers: the Dexie schema and every db function, the offline PIN flow, the
rule-based risk model, the heatmap grid, and both sync-queue drain services.

## Not built yet

- A configurable API base URL. `services/*.js` call relative paths
  (`/api/sync`, `/api/admin/...`), so the app must be served from the same
  origin as Tier 2 or behind a proxy that routes `/api` there.
- Real Cognito-verified sign-in (see **Configuration** above)
- Risk scoring in a Web Worker (`lib/riskModel.js` has no React or Dexie
  dependencies, so it is ready for this)
