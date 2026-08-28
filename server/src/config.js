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
};
