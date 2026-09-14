/**
 * Backfills ~1 month of attendance_events for the seeded demo roster (see
 * db/seed.js) so the admin endpoints (routes/admin.js) have real numbers to
 * show right after `npm run db:reset` - a school with a single day of
 * attendance can't demonstrate an absenteeism trend or a risk flag.
 *
 * Deterministic (same seed -> same history) and mirrors the profile shapes
 * client/src/db/seedData.js uses for its own demo history, so the server and
 * client tell the same visual story if both are demoed side by side. Skipped
 * if the roster already has attendance history, so it never overwrites a real
 * pilot's data.
 *
 * Run directly: node src/db/seedHistory.js   (wired to `npm run db:seed-history`)
 */
import { openDatabase } from './index.js';
import { DEMO_STUDENTS } from './seed.js';
import { recordAttendance } from './repository.js';

const HISTORY_WEEKS = 4;

function mulberry32(seed) {
  return function next() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function isoAddDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
function todayISO(now = new Date()) {
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().split('T')[0];
}

// ctx: { rand [0,1), fromEnd: school days remaining until today }. 'present' | 'absent' | 'late'.
const PROFILES = {
  steady: ({ rand }) => (rand < 0.04 ? 'absent' : rand < 0.1 ? 'late' : 'present'),
  latecomer: ({ rand }) => (rand < 0.05 ? 'absent' : rand < 0.34 ? 'late' : 'present'),
  declining: ({ rand, fromEnd }) => {
    if (fromEnd <= 6) return 'absent';
    const p = fromEnd <= 22 ? 0.14 + (22 - fromEnd) * 0.02 : 0.06;
    return rand < p ? 'absent' : rand < p + 0.08 ? 'late' : 'present';
  },
  wobbling: ({ rand, fromEnd }) => {
    if (fromEnd >= 12 && fromEnd <= 13) return 'absent';
    const p = fromEnd <= 18 ? 0.16 : 0.06;
    return rand < p ? 'absent' : rand < p + 0.1 ? 'late' : 'present';
  },
};
const PROFILE_BY_STUDENT = {
  'stu-form3b-001': 'steady', 'stu-form3b-002': 'steady', 'stu-form3b-003': 'latecomer',
  'stu-form3b-004': 'steady', 'stu-form3b-005': 'steady', 'stu-form3b-006': 'steady',
  'stu-form3b-007': 'declining', 'stu-form3b-008': 'wobbling', 'stu-form3b-009': 'latecomer',
  'stu-form3b-010': 'steady',
};

/** @returns {{seeded: boolean, count?: number}} */
export function seedHistory(db, today = new Date()) {
  const already = db.prepare('SELECT COUNT(*) AS n FROM attendance_events').get().n;
  if (already > 0) return { seeded: false };

  const todayIso = todayISO(today);
  const g = new Date(todayIso).getDay();
  const monday = isoAddDays(todayIso, -(g === 0 ? 6 : g - 1) - HISTORY_WEEKS * 7);

  const schoolDays = [];
  for (let d = 0; d < (HISTORY_WEEKS + 1) * 7; d += 1) {
    const date = isoAddDays(monday, d);
    if (date >= todayIso) break;
    const dow = new Date(date).getDay();
    if (dow >= 1 && dow <= 5) schoolDays.push(date);
  }

  let count = 0;
  for (const student of DEMO_STUDENTS) {
    const profile = PROFILES[PROFILE_BY_STUDENT[student.student_id] ?? 'steady'];
    const total = schoolDays.length;
    schoolDays.forEach((date, idx) => {
      const rand = mulberry32(hashStr(`${student.student_id}:${date}`))();
      const status = profile({ rand, fromEnd: total - idx });
      recordAttendance(db, {
        studentId: student.student_id,
        date,
        status,
        captureMethod: 'import',
        source: 'simulation',
      });
      count += 1;
    });
  }

  return { seeded: true, count };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('seedHistory.js')) {
  const db = openDatabase();
  console.log(seedHistory(db));
  db.close();
}
