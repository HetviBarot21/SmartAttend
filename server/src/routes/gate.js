/**
 * GET /api/gate/* - what the school gate (RFID + fingerprint) has recorded,
 * for the teacher PWA to pull down before roll call.
 *
 * The flow this backs: students tap in at the gate -> the teacher opens the
 * PWA, which pulls today's records for their class and stores them in its own
 * IndexedDB -> the roll call shows those students as already present, so the
 * teacher only deals with whoever did not scan (mark absent + reason, or
 * present if they forgot their card) and confirms. Only those changes go back
 * up through POST /api/sync.
 *
 * `gate.lastScanAt` lets the PWA tell "nobody has scanned yet" apart from
 * "the gate is down" and fall back to a full manual roll call.
 */

import { Router } from 'express';
import {
  getClassGroup,
  getClassAttendanceForDate,
  getLastGateScanAt,
  todayISO,
} from '../db/repository.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function createGateRouter({ db }) {
  if (!db) throw new Error('createGateRouter needs a db');
  const router = Router();

  router.get('/classes/:id/attendance', (req, res) => {
    const date = req.query.date || todayISO();
    if (!DATE_RE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });

    const cls = getClassGroup(db, req.params.id);
    if (!cls) return res.status(404).json({ error: 'class not found' });

    res.json({
      classGroupId: req.params.id,
      date,
      gate: { lastScanAt: getLastGateScanAt(db) },
      records: getClassAttendanceForDate(db, req.params.id, date),
    });
  });

  return router;
}
