import { db, getStudentsByClass, newId } from './database';

export const DEMO_CLASS_ID = 'class-form3b-001';

export const DEMO_CLASS = {
  classGroupId: DEMO_CLASS_ID,
  schoolId: 'school-kibera-001',
  grade: 'Form 3',
  stream: 'B',
  name: 'Form 3 B',
  academicYear: 2026,
  active: true,
  createdAt: '2026-01-06T00:00:00.000Z',
  demo: true,
};

// Fixed IDs so a reseed keeps the same students.
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

/** Load the Form 3 B sample class. Safe to run more than once. */
export async function seedDemoClass() {
  await db.transaction('rw', db.classGroups, db.students, async () => {
    const cls = await db.classGroups.where('classGroupId').equals(DEMO_CLASS_ID).first();
    if (!cls) await db.classGroups.add(DEMO_CLASS);
    else if (cls.active === undefined || !cls.createdAt) {
      await db.classGroups.update(cls.id, { active: true, createdAt: DEMO_CLASS.createdAt, demo: true });
    }

    for (const student of DEMO_STUDENTS) {
      const found = await db.students.where('studentId').equals(student.studentId).first();
      if (!found) await db.students.add({ ...student, active: true });
    }
  });

  await seedDemoHistory();
  return { classGroupId: DEMO_CLASS_ID, count: DEMO_STUDENTS.length };
}

// Demo attendance history. Deterministic, and only written when the log is empty.

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

// Each profile maps { rand, fromEnd } to a status. fromEnd counts school days left.
const HISTORY_PROFILES = {
  // green
  steady: ({ rand }) => (rand < 0.04 ? 'absent' : rand < 0.1 ? 'late' : 'present'),

  // often late, green
  latecomer: ({ rand }) => (rand < 0.05 ? 'absent' : rand < 0.34 ? 'late' : 'present'),

  // collapses into a 6-day absence streak: red
  declining: ({ rand, fromEnd }) => {
    if (fromEnd <= 6) return 'absent';
    const p = fromEnd <= 22 ? 0.14 + (22 - fromEnd) * 0.02 : 0.06;
    return rand < p ? 'absent' : rand < p + 0.08 ? 'late' : 'present';
  },

  // a 2-day block two weeks ago, then slightly more absences: amber
  wobbling: ({ rand, fromEnd }) => {
    if (fromEnd >= 12 && fromEnd <= 13) return 'absent';
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
 * Disable with `localStorage['smartattend:no-demo-history'] = '1'`.
 * @returns {{seeded: boolean, count?: number}}
 */
export async function seedDemoHistory(today = new Date()) {
  try {
    if (globalThis.localStorage?.getItem('smartattend:no-demo-history') === '1') {
      return { seeded: false };
    }
  } catch { /* no localStorage */ }

  const already = await db.attendanceEvents.count();
  if (already > 0) return { seeded: false };

  const todayISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const g = today.getDay();
  const monday = isoAddDays(todayISO, -(g === 0 ? 6 : g - 1) - HISTORY_WEEKS * 7);

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
        syncedAt: now,
        createdAt: now,
      });
    });
  }

  await db.attendanceEvents.bulkAdd(rows);
  return { seeded: true, count: rows.length };
}

// Sample history for a real class. Unlike the demo history, these rows are synced.

// Mostly green, with a few amber and red students.
const SAMPLE_PROFILE_POOL = ['steady', 'steady', 'steady', 'latecomer', 'wobbling', 'declining'];
function profileForStudent(studentId) {
  return SAMPLE_PROFILE_POOL[hashStr(studentId) % SAMPLE_PROFILE_POOL.length];
}

/**
 * Generate sample history for a class that has none yet.
 *
 * @returns {Promise<{seeded: boolean, reason?: string, count?: number, studentCount?: number}>}
 */
export async function generateSampleHistory(classGroupId, { weeks = 4, today = new Date() } = {}) {
  const students = await getStudentsByClass(classGroupId);
  if (students.length === 0) return { seeded: false, reason: 'This class has no students to generate history for yet.' };

  const studentIds = students.map((s) => s.studentId);
  const existing = await db.attendanceEvents.where('studentId').anyOf(studentIds).count();
  if (existing > 0) return { seeded: false, reason: 'This class already has attendance history.' };

  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const g = today.getDay();
  const monday = isoAddDays(todayIso, -(g === 0 ? 6 : g - 1) - weeks * 7);

  const schoolDays = [];
  for (let day = 0; day < (weeks + 1) * 7; day += 1) {
    const date = isoAddDays(monday, day);
    if (date >= todayIso) break;
    const [yy, mm, dd] = date.split('-').map(Number);
    const dow = new Date(yy, mm - 1, dd).getDay();
    if (dow >= 1 && dow <= 5) schoolDays.push(date);
  }

  const now = new Date().toISOString();
  const total = schoolDays.length;
  const eventRows = [];
  const queueRows = [];

  for (const student of students) {
    const profile = HISTORY_PROFILES[profileForStudent(student.studentId)];
    schoolDays.forEach((date, idx) => {
      const rand = mulberry32(hashStr(`${student.studentId}:${date}`))();
      const status = profile({ rand, fromEnd: total - idx });
      // The sync schema requires a UUID.
      const eventId = newId();
      eventRows.push({
        eventId, studentId: student.studentId, date, status,
        captureMethod: 'import', recordedBy: null, syncedAt: null, createdAt: now,
      });
      queueRows.push({ eventId, status: 'pending', createdAt: now, attemptCount: 0 });
    });
  }

  await db.transaction('rw', db.attendanceEvents, db.syncQueue, async () => {
    await db.attendanceEvents.bulkAdd(eventRows);
    await db.syncQueue.bulkAdd(queueRows);
  });

  return { seeded: true, count: eventRows.length, studentCount: students.length };
}
