import express from 'express';
import morgan from 'morgan';
import { createCardHandler } from './attendance/handler.js';
import { createSyncRouter } from './routes/sync.js';
import { createRosterRouter } from './routes/roster.js';
import { createAdminRouter } from './routes/admin.js';
import { createSystemAdminRouter } from './routes/systemAdmin.js';
import {
  getAttendanceForDate,
  getRecentChallenges,
  getStats,
  countPendingSync,
  todayISO,
} from './db/repository.js';

/**
 * Build the Express app around an open database.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {ReturnType<typeof createCardHandler>} [opts.cardHandler]
 */
export function createApp({ db, cardHandler = createCardHandler({ db }), logger = true } = {}) {
  const app = express();
  app.use(express.json());
  if (logger) app.use(morgan('dev'));

  app.get('/health', (req, res) => {
    const tables = db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .get().n;
    res.json({ status: 'ok', uptime: process.uptime(), tables, pendingSync: countPendingSync(db) });
  });

  app.get('/api/students', (req, res) => {
    res.json(db.prepare('SELECT * FROM students ORDER BY full_name').all());
  });

  app.get('/api/attendance', (req, res) => {
    const date = req.query.date || todayISO();
    res.json({ date, records: getAttendanceForDate(db, date) });
  });

  app.get('/api/challenges', (req, res) => {
    res.json({ challenges: getRecentChallenges(db, Number(req.query.limit) || 50) });
  });

  app.get('/api/stats', (req, res) => {
    res.json(getStats(db, req.query.date || todayISO()));
  });

  // Inbound sync from the offline PWA. Lands records in attendance_events +
  // sync_queue; src/workers/syncWorker.js pushes them on to AWS.
  app.use('/api/sync', createSyncRouter({ db }));

  // Roster upserts pushed from the PWA (schools/classes/students/cards), and
  // the cross-class/cross-teacher admin reporting built on top of them.
  app.use('/api/roster', createRosterRouter({ db }));
  app.use('/api/admin', createAdminRouter({ db }));

  // Platform-wide school list + activate/deactivate, for the system-admin role.
  app.use('/api/system-admin', createSystemAdminRouter({ db }));

  // Manually fire one scan - lets the demo show an outcome without waiting for
  // the 5s emitter tick. Body: { "cardUid": "04A1B2C3" }
  app.post('/api/rfid/scan', (req, res) => {
    const { cardUid } = req.body ?? {};
    if (!cardUid) return res.status(400).json({ error: 'cardUid is required' });
    const result = cardHandler({ cardUid });
    const status = result.outcome === 'unknown-card' ? 404 : 200;
    res.status(status).json(result);
  });

  app.use((req, res) => res.status(404).json({ error: 'not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
