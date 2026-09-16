# Client (Tier 1 Offline-First PWA)

React 19 + Vite installable PWA that a teacher uses to take attendance from a
phone or tablet with no reliable connectivity. Local PIN auth, an offline
roster/attendance store in IndexedDB, and a background sync queue that drains
to the Tier 2 server (`../server`) once the device is back online.

## Requirements

- Node.js 22+
- On Windows, run `npm install` from PowerShell, not Git Bash (see
  `../server/README.md` for why - same OneDrive/native-module issue).

## Quick start

```bash
cd client
npm install
npm run dev        # http://localhost:5173, /api/* proxied to Tier 2 on :3000
```

Start `../server` first (`npm start` there) so sign-up/roster/sync calls have
somewhere to land - the dev server proxies `/api/*` to `http://localhost:3000`
(`vite.config.js`). Without a Tier 2 server running, the app still works fully
offline (local PIN auth, local attendance) - sync attempts just fail silently
and stay queued, same as any offline scenario.

## Roles

Chosen at sign-up (`components/LoginScreen.jsx`), stored on the session:

| Role | Screen(s) | What they see |
|---|---|---|
| `teacher` | Attendance / Heatmap / Alerts / Student Profile | Their own class(es), full attendance editing |
| `admin` (school admin) | Overview + read-only class drill-down | Every class/teacher in their school, cross-class flagged students, follow-up logging - see `components/AdminOverview.jsx` |
| `system_admin` | System Admin | Every school on the platform, activate/deactivate - see `components/SystemAdminOverview.jsx`. Skips class setup and offline-PIN gating entirely (not a field role) |

## Configuration

No `.env` is required for local development - see **Local authentication
mode** below. Two optional Vite env vars switch auth to real AWS Cognito:

| Variable | Default | Meaning |
|---|---|---|
| `VITE_COGNITO_USER_POOL_ID` | *(unset)* | Cognito user pool ID |
| `VITE_COGNITO_CLIENT_ID` | *(unset)* | Cognito app client ID |

### Local authentication mode

With neither Cognito variable set (the default), `auth/cognito.js` mints a
device-local session for any email/password - there is no credential check.
Sign-up just records a display name, chosen role, and (for `admin`) a school
name in IndexedDB, purely so the app can greet the teacher by name and restore
their role on the next sign-in. See `../PROJECT_CONTEXT.md` for the plan to
replace this with a real Cognito pool.

## What's in `src/`

- `auth/` - `cognito.js` (local-mode/Cognito auth), `pin.js` (offline PIN,
  hashed with `bcryptjs`), `AuthContext.jsx`
- `db/database.js` - the Dexie (IndexedDB) schema: classes, students, roster,
  attendance, `syncQueue`, `rosterSyncQueue`, `riskScores`, `followUps`
- `components/` - screens: `AttendanceForm`, `Heatmap`, `Alerts`,
  `StudentProfile`, `RosterManager`, `SetupWizard` (first-run onboarding),
  `AdminOverview` / `AdminClassDetail`, `SystemAdminOverview`
- `services/` - `syncService.js` (outbound attendance sync drain),
  `rosterSyncService.js` (outbound roster sync drain), `adminService.js` /
  `systemAdminService.js` (live fetches, not Dexie - see their file comments)
- `lib/` - `riskModel.js` (rule-based scorer, a JS port of the ML model, kept
  React/Dexie-free so it can later run in a Web Worker), `heatmap.js`,
  `attendanceSummary.js`
- `sw/sw.js` - custom service worker (Workbox Background Sync for the
  navigation-route/offline-shell precache `vite-plugin-pwa`'s generated SW
  doesn't cover on its own)

## Sync: here → Tier 2 → AWS

Outbound only from this side. `services/syncService.js` /
`rosterSyncService.js` drain `syncQueue` / `rosterSyncQueue` (populated by
every attendance write / roster edit in `db/database.js`) via
`POST /api/sync` and the `/api/roster/*` upserts, triggered on reconnect
(`hooks/useOnlineStatus.js`) and via the service worker's Background Sync.
From there it's Tier 2's job - see `../server/README.md`'s sync section for
the rest of the path to AWS.

## Tests

```bash
npm test             # jest, 73 tests
npm run lint          # eslint
```

Covers: the Dexie schema and every db function, the offline PIN flow, the
rule-based risk model, the heatmap grid, and both sync-queue drain services.

## Not built yet

- A configurable API base URL - `services/*.js` all call relative paths
  (`/api/sync`, `/api/admin/...`), which assumes this app is served from the
  same origin as Tier 2 (or fronted by a reverse proxy that routes `/api`
  there). There's no env var yet to point a built client at a Tier 2 server
  hosted elsewhere.
- Real Cognito-verified sign-in (see **Configuration** above)
- Risk scoring running in a client Web Worker (the model - `lib/riskModel.js`
  - is ready for it; not yet wired up)
