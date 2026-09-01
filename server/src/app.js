'use strict';

/**
 * Express app for the Tier 2 simulated backend. Kept separate from index.js so
 * tests can import the app without binding a port or spawning the sync worker.
 */

const express = require('express');
const cors = require('cors');

const syncRoutes = require('./routes/sync');

function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

  app.use('/api/sync', syncRoutes);

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error('[app] unhandled error', err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

module.exports = { createApp };
