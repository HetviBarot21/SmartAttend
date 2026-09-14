/**
 * GET/POST /api/admin/* - read-only cross-class/cross-teacher reporting for a
 * school, plus the follow-up log. Backs client/src/components/AdminOverview.jsx
 * and AdminClassDetail.jsx via client/src/services/adminService.js.
 *
 * There is no separate admin identity system (see PROJECT_CONTEXT.md /
 * PLAN.md non-goals) - the client only shows these screens to a session with
 * role 'admin'; the server trusts whatever schoolId it is asked about, same
 * trust level as the rest of this sprint-stage backend.
 */

import { Router } from 'express';
import {
  getSchoolOverview,
  getClassesForSchool,
  getClassGroup,
  getStudentsForClass,
  getFlaggedStudents,
  addFollowUp,
  getFollowUps,
} from '../db/repository.js';

export function createAdminRouter({ db }) {
  if (!db) throw new Error('createAdminRouter needs a db');
  const router = Router();

  router.get('/schools/:schoolId/overview', (req, res) => {
    res.json(getSchoolOverview(db, req.params.schoolId));
  });

  router.get('/schools/:schoolId/classes', (req, res) => {
    res.json({ classes: getClassesForSchool(db, req.params.schoolId) });
  });

  router.get('/classes/:id/students', (req, res) => {
    const cls = getClassGroup(db, req.params.id);
    if (!cls) return res.status(404).json({ error: 'class not found' });
    res.json({ class: cls, students: getStudentsForClass(db, req.params.id) });
  });

  router.get('/schools/:schoolId/flagged', (req, res) => {
    res.json({ flagged: getFlaggedStudents(db, req.params.schoolId) });
  });

  router.post('/students/:id/follow-ups', (req, res) => {
    const { flag, method, note, actor } = req.body ?? {};
    if (!flag || !method) return res.status(400).json({ error: 'flag and method are required' });
    res.status(201).json(addFollowUp(db, { studentId: req.params.id, flag, method, note, actor }));
  });

  router.get('/students/:id/follow-ups', (req, res) => {
    res.json({ followUps: getFollowUps(db, req.params.id) });
  });

  return router;
}
