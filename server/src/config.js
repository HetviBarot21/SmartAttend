// Central config. Everything is overridable by an environment variable so the
// same code runs in the Friday demo, in tests, and later in a container.
import { resolve, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

// This repo commonly lives under "OneDrive/..." on Windows. OneDrive keeps file
// handles open to sync changes, which deadlocks SQLite's WAL files after the
// first write. So the database lives OUTSIDE the project by default. Override
// with DB_PATH if your checkout is not under a syncing folder.
const defaultDbDir =
  process.env.LOCALAPPDATA ||
  (process.platform === 'win32' ? join(homedir(), 'AppData', 'Local') : tmpdir());

export const config = {
  port: num(process.env.PORT, 3000),

  // Absolute path to the SQLite file, or ':memory:' for an ephemeral DB.
  dbPath:
    process.env.DB_PATH === ':memory:'
      ? ':memory:'
      : process.env.DB_PATH
        ? resolve(process.env.DB_PATH)
        : join(defaultDbDir, 'smartattend', 'smartattend.db'),

  // Mock RFID reader: emit a card-detected event this often.
  rfidIntervalMs: num(process.env.RFID_INTERVAL_MS, 5000),

  // Fraction of RFID scans that trigger a fingerprint challenge (0..1).
  fingerprintChallengeRate: num(process.env.FINGERPRINT_CHALLENGE_RATE, 0.25),

  // Fraction of fingerprint challenges the mock scanner reports as a match (0..1).
  fingerprintSuccessRate: num(process.env.FINGERPRINT_SUCCESS_RATE, 0.9),

  // Start the RFID simulation loop when the server boots.
  simulationEnabled: process.env.SIMULATION_ENABLED !== 'false',

  // Outbound cloud sync (src/workers/syncWorker.js). The worker drains
  // sync_queue and POSTs batches to the AWS sync Lambda via API Gateway. With
  // no real AWS yet, point apiUrl at a local shim around aws/lambda/syncHandler.js.
  sync: {
    workerDisabled: process.env.SYNC_WORKER_DISABLED === 'true',
    apiUrl: process.env.SYNC_API_GATEWAY_URL || '',
    apiKey: process.env.SYNC_API_GATEWAY_KEY || '',
    pollIntervalMs: num(process.env.SYNC_POLL_INTERVAL_MS, 30_000),
    batchSize: num(process.env.SYNC_BATCH_SIZE, 50),
    backoffMinMs: num(process.env.SYNC_BACKOFF_MIN_MS, 60_000),
    backoffMaxMs: num(process.env.SYNC_BACKOFF_MAX_MS, 30 * 60_000),
    maxAttempts: num(process.env.SYNC_MAX_ATTEMPTS, 12),
    requestTimeoutMs: num(process.env.SYNC_REQUEST_TIMEOUT_MS, 15_000),
    deviceId: process.env.SYNC_DEVICE_ID || 'tier2-server',
  },
};
