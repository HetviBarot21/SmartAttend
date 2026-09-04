import { Worker } from 'node:worker_threads';
import { config } from './config.js';
import { getDb, closeDb } from './db/index.js';
import { seed } from './db/seed.js';
import { createApp } from './app.js';
import { createCardHandler } from './attendance/handler.js';
import { RfidEmitter } from './simulation/rfidEmitter.js';

const db = getDb();
seed(db); // idempotent - roster is present on every boot

const cardHandler = createCardHandler({ db });
const app = createApp({ db, cardHandler });

const server = app.listen(config.port, () => {
  console.log(`SmartAttend server listening on http://localhost:${config.port}`);
  console.log(`  DB: ${config.dbPath}`);
});

// --- outbound sync worker -------------------------------------------------
// Drains sync_queue and POSTs batches to AWS. Runs in its own thread so a slow
// or hanging cloud request never blocks the HTTP server or the simulation.
let syncWorker = null;
if (!config.sync.workerDisabled) {
  syncWorker = new Worker(new URL('./workers/syncWorker.js', import.meta.url), {
    workerData: { env: process.env },
  });
  syncWorker.on('message', (m) => console.log('[syncWorker]', m));
  syncWorker.on('error', (e) => console.error('[syncWorker] crashed', e));
  syncWorker.on('exit', (code) => {
    if (code !== 0) console.error(`[syncWorker] exited with code ${code}`);
  });
}

const reader = new RfidEmitter();

reader.on('card-detected', (scan) => {
  try {
    const result = cardHandler(scan);
    logOutcome(scan, result);
  } catch (err) {
    console.error(`[rfid] handler crashed on ${scan.cardUid}:`, err.message);
  }
});

if (config.simulationEnabled) {
  reader.start();
  console.log(
    `RFID simulation on: a scan every ${config.rfidIntervalMs / 1000}s, ` +
      `${Math.round(config.fingerprintChallengeRate * 100)}% fingerprint challenge, ` +
      `${Math.round(config.fingerprintSuccessRate * 100)}% success rate`
  );
} else {
  console.log('RFID simulation off (SIMULATION_ENABLED=false). POST /api/rfid/scan to test manually.');
}

function logOutcome(scan, result) {
  const who = result.student ? `${result.student.full_name} (${result.student.student_id})` : scan.cardUid;
  switch (result.outcome) {
    case 'recorded':
      console.log(
        `[rfid] ${who} -> present via ${result.event.capture_method ?? result.event.captureMethod}` +
          `${result.challenged ? ' (fingerprint verified)' : ''}`
      );
      break;
    case 'duplicate':
      console.log(`[rfid] ${who} -> already recorded today, ignored`);
      break;
    case 'rejected':
      console.log(`[rfid] ${who} -> REJECTED: fingerprint no-match (possible buddy punch)`);
      break;
    case 'unknown-card':
      console.log(`[rfid] unknown card ${scan.cardUid}, ignored`);
      break;
    default:
      console.log(`[rfid] ${who} -> ${result.outcome}`);
  }
}

function shutdown(signal) {
  console.log(`\n${signal} received, shutting down`);
  reader.stop();
  server.close(async () => {
    if (syncWorker) await syncWorker.terminate();
    closeDb();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
