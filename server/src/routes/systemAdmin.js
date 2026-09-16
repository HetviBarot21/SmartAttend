/**
 * GET/POST /api/system-admin/* - platform-wide view across every school, for
 * the system-admin role (above school admin - see AdminOverview.jsx for the
 * per-school view). Currently just school listing + activate/deactivate; no
 * identity system enforces who can call this yet (same trust level as the
 * rest of this sprint-stage backend - see admin.js).
 */

import { Router } from 'express';
import { getAllSchools, setSchoolStatus } from '../db/repository.js';

export function createSystemAdminRouter({ db }) {
  if (!db) throw new Error('createSystemAdminRouter needs a db');
  const router = Router();

  router.get('/schools', (req, res) => {
    res.json({ schools: getAllSchools(db) });
  });

  router.post('/schools/:id/status', (req, res) => {
    const { status } = req.body ?? {};
    if (status !== 'active' && status !== 'inactive') {
      return res.status(400).json({ error: "status must be 'active' or 'inactive'" });
    }
    const updated = setSchoolStatus(db, req.params.id, status);
    if (!updated) return res.status(404).json({ error: 'school not found' });
    res.json(updated);
  });

  return router;
}
