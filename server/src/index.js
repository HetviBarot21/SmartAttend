'use strict';

/**
 * Entry point: loads .env, opens the database, starts the HTTP server and
 * spawns the outbound sync worker thread.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { Worker } = require('worker_threads');
const path = require('path');
const { createApp } = require('./app');
require('./db'); // opens the connection and applies the schema

const PORT = Number(process.env.PORT) || 3000;

const app = createApp();
const server = app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});

// --- outbound sync worker --------------------------------------------------
let syncWorker;
if (process.env.SYNC_WORKER_DISABLED !== 'true') {
  syncWorker = new Worker(path.join(__dirname, 'workers', 'syncWorker.js'), {
    workerData: { env: process.env }
  });
  syncWorker.on('message', (m) => console.log('[syncWorker]', m));
  syncWorker.on('error', (e) => console.error('[syncWorker] crashed', e));
  syncWorker.on('exit', (code) => {
    if (code !== 0) console.error(`[syncWorker] exited with code ${code}`);
  });
}

function shutdown(signal) {
  console.log(`[server] ${signal} received, shutting down`);
  server.close(() => {
    if (syncWorker) syncWorker.terminate().finally(() => process.exit(0));
    else process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
