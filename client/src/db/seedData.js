import { db } from './database';

export const DEMO_CLASS_ID = 'class-form3b-001';

export const DEMO_CLASS = {
  classGroupId: DEMO_CLASS_ID,
  schoolId: 'school-kibera-001',
  grade: 'Form 3',
  stream: 'B',
  academicYear: 2026
};

// Student IDs are fixed rather than random so a reseed keeps the same identities:
// attendance history, risk scores and RFID card bindings all key on studentId,
// and a demo that regenerates them every load cannot show a trend over time.
export const DEMO_STUDENTS = [
  { studentId: 'stu-form3b-001', admissionNo: '3B/001', fullName: 'Amina Wanjiru' },
  { studentId: 'stu-form3b-002', admissionNo: '3B/002', fullName: 'Brian Kamau' },
  { studentId: 'stu-form3b-003', admissionNo: '3B/003', fullName: 'Daniel Mutua' },
  { studentId: 'stu-form3b-004', admissionNo: '3B/004', fullName: 'Faith Achieng' },
  { studentId: 'stu-form3b-005', admissionNo: '3B/005', fullName: 'Grace Muthoni' },
  { studentId: 'stu-form3b-006', admissionNo: '3B/006', fullName: 'Jack Otieno' },
  { studentId: 'stu-form3b-007', admissionNo: '3B/007', fullName: 'Kevin Odhiambo' },
  { studentId: 'stu-form3b-008', admissionNo: '3B/008', fullName: 'Lydia Chebet' },
  { studentId: 'stu-form3b-009', admissionNo: '3B/009', fullName: 'Moses Kipchoge' },
  { studentId: 'stu-form3b-010', admissionNo: '3B/010', fullName: 'Naomi Waweru' }
].map((s) => ({ ...s, classGroupId: DEMO_CLASS_ID, enrolledAt: '2026-01-06' }));

/**
 * One-time demo seed: the class group + the 10 demo students, but ONLY on a
 * device whose roster is still empty. Once a teacher has touched the roster
 * (added or removed a student) we must not re-add the demo names on the next
 * load, so the guard is "are there any students in this class" rather than the
 * old "are there exactly 10".
 */
export async function seedDatabase() {
  const existing = await db.students.where('classGroupId').equals(DEMO_CLASS_ID).count();
  if (existing > 0) return { seeded: false };

  await db.transaction('rw', db.classGroups, db.students, async () => {
    const cls = await db.classGroups.where('classGroupId').equals(DEMO_CLASS_ID).first();
    if (!cls) await db.classGroups.add(DEMO_CLASS);
    await db.students.bulkAdd(DEMO_STUDENTS.map((s) => ({ ...s, active: true })));
  });

  return { seeded: true, count: DEMO_STUDENTS.length };
}

// --------------------------------------------------------------------------- //
// Demo attendance history                                                     //
//                                                                             //
// The Heatmap, Alerts and Profile screens need weeks of history to show a     //
// trend or a risk flag. This backfills ~11 weeks of plausible records so the  //
// screens are demoable on a fresh device. It is deterministic (a reseed gives //
// the identical history) and it runs ONLY when the log is empty, so it never  //
// touches attendance a teacher actually recorded.                             //
// --------------------------------------------------------------------------- //

const HISTORY_WEEKS = 11;

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

// ctx: { rand [0,1), dow 0-6, idx school-day index from start, fromEnd days-left,
//        total school days }. Returns 'present' | 'absent' | 'late'.
const HISTORY_PROFILES = {
  // steady, high attendance — stays green
  steady: ({ rand }) => (rand < 0.04 ? 'absent' : rand < 0.1 ? 'late' : 'present'),

  // punctuality slips, attendance fine — stays green
  latecomer: ({ rand }) => (rand < 0.05 ? 'absent' : rand < 0.34 ? 'late' : 'present'),

  // fine for weeks, then a hard collapse ending in a 6-day streak — RED
  declining: ({ rand, fromEnd }) => {
    if (fromEnd <= 6) return 'absent';
    const p = fromEnd <= 22 ? 0.14 + (22 - fromEnd) * 0.02 : 0.06;
    return rand < p ? 'absent' : rand < p + 0.08 ? 'late' : 'present';
  },

  // a rough patch: a short block ~2 weeks ago + slightly raised absence since — AMBER
  wobbling: ({ rand, fromEnd }) => {
    if (fromEnd >= 12 && fromEnd <= 13) return 'absent'; // a 2-day blip
    const p = fromEnd <= 18 ? 0.16 : 0.06;
    return rand < p ? 'absent' : rand < p + 0.1 ? 'late' : 'present';
  },
};

const STUDENT_PROFILE = {
  'stu-form3b-001': 'steady',
  'stu-form3b-002': 'steady',
  'stu-form3b-003': 'latecomer',
  'stu-form3b-004': 'steady',
  'stu-form3b-005': 'steady',
  'stu-form3b-006': 'steady',
  'stu-form3b-007': 'declining',
  'stu-form3b-008': 'wobbling',
  'stu-form3b-009': 'latecomer',
  'stu-form3b-010': 'steady',
};

/**
 * @returns {{seeded: boolean, count?: number}}
 *
 * Demo scaffolding. Skipped once any real attendance exists, and can be turned
 * off entirely with `localStorage['smartattend:no-demo-history'] = '1'` before
 * first launch (e.g. for a real pilot device).
 */
export async function seedDemoHistory(today = new Date()) {
  try {
    if (globalThis.localStorage?.getItem('smartattend:no-demo-history') === '1') {
      return { seeded: false };
    }
  } catch { /* localStorage unavailable — proceed */ }

  const already = await db.attendanceEvents.count();
  if (already > 0) return { seeded: false };

  const todayISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  // start on the Monday HISTORY_WEEKS ago
  const g = today.getDay();
  const monday = isoAddDays(todayISO, -(g === 0 ? 6 : g - 1) - HISTORY_WEEKS * 7);

  // school days from `monday` up to (not including) today. The +7 headroom lets
  // the loop actually reach yesterday; the `>= todayISO` check is the real bound.
  const schoolDays = [];
  for (let day = 0; day < (HISTORY_WEEKS + 1) * 7; day += 1) {
    const date = isoAddDays(monday, day);
    if (date >= todayISO) break;
    const [yy, mm, dd] = date.split('-').map(Number);
    const dow = new Date(yy, mm - 1, dd).getDay();
    if (dow >= 1 && dow <= 5) schoolDays.push({ date, dow });
  }

  const now = new Date().toISOString();
  const total = schoolDays.length;
  const rows = [];

  for (const student of DEMO_STUDENTS) {
    const profile = HISTORY_PROFILES[STUDENT_PROFILE[student.studentId] ?? 'steady'];
    schoolDays.forEach(({ date, dow }, idx) => {
      const rand = mulberry32(hashStr(`${student.studentId}:${date}`))();
      const status = profile({ rand, dow, idx, fromEnd: total - idx, total });
      rows.push({
        eventId: `demo-${student.studentId}-${date}`,
        studentId: student.studentId,
        date,
        status,
        captureMethod: 'import',
        recordedBy: null,
        syncedAt: now, // historical import — already reconciled, keeps it out of the sync badge
        createdAt: now,
      });
    });
  }

  await db.attendanceEvents.bulkAdd(rows);
  return { seeded: true, count: rows.length };
}
