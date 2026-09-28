/** POST/PATCH /api/roster/*: idempotent roster upserts pushed from the PWA. */

import { Router } from 'express';
import {
  upsertSchool,
  upsertClassGroup,
  patchClassGroup,
  upsertStudent,
  patchStudent,
  upsertCard,
} from '../db/repository.js';

export function createRosterRouter({ db }) {
  if (!db) throw new Error('createRosterRouter needs a db');
  const router = Router();

  const require = (res, body, fields) => {
    const missing = fields.filter((f) => body[f] === undefined || body[f] === null || body[f] === '');
    if (missing.length > 0) {
      res.status(400).json({ error: `missing field(s): ${missing.join(', ')}` });
      return false;
    }
    return true;
  };

  router.post('/schools', (req, res) => {
    const body = req.body ?? {};
    if (!require(res, body, ['schoolId', 'name'])) return;
    res.status(200).json(upsertSchool(db, body));
  });

  router.post('/classes', (req, res) => {
    const body = req.body ?? {};
    if (!require(res, body, ['classGroupId', 'schoolId', 'grade'])) return;
    try {
      res.status(200).json(upsertClassGroup(db, body));
    } catch (err) {
      if (err?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        return res.status(409).json({ error: 'unknown schoolId - push the school first' });
      }
      throw err;
    }
  });

  router.patch('/classes/:id', (req, res) => {
    patchClassGroup(db, req.params.id, req.body ?? {});
    res.status(200).json({ classGroupId: req.params.id, updated: true });
  });

  router.post('/students', (req, res) => {
    const body = req.body ?? {};
    if (!require(res, body, ['studentId', 'classGroupId', 'fullName'])) return;
    try {
      res.status(200).json(upsertStudent(db, body));
    } catch (err) {
      if (err?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        return res.status(409).json({ error: 'unknown classGroupId - push the class first' });
      }
      throw err;
    }
  });

  router.patch('/students/:id', (req, res) => {
    patchStudent(db, req.params.id, req.body ?? {});
    res.status(200).json({ studentId: req.params.id, updated: true });
  });

  router.post('/students/:id/card', (req, res) => {
    const body = req.body ?? {};
    if (!require(res, body, ['cardUid'])) return;
    try {
      res.status(200).json(upsertCard(db, { cardUid: body.cardUid, studentId: req.params.id }));
    } catch (err) {
      if (err?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        return res.status(409).json({ error: 'unknown studentId - push the student first' });
      }
      throw err;
    }
  });

  return router;
}
