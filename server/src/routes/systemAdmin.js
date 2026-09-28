/** /api/system-admin/*: list schools and activate or deactivate them. No auth check yet. */

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
