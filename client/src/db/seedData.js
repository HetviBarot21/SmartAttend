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
 * Load the sample class (Form 3 B + 10 students) on demand - the "Load a sample
 * class" option in the setup wizard, so the Heatmap / Alerts screens have
 * something to show before a real roster is entered.
 *
 * No longer runs automatically on every screen load: a teacher who has created
 * their own class should never see the demo names appear. Idempotent - adds the
 * class and any missing demo students, repairs an older demo class row that
 * predates the `active` / `createdAt` fields.
 */
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

// --------------------------------------------------------------------------- //
// Sample history for a REAL class                                             //
//                                                                             //
// seedDemoHistory() above only ever touches the fixed Form 3 B demo roster.   //
// This is the same generator made to work on any class's real students - the //
// "Generate sample month" action in RosterManager, for demoing the risk model //
// (lib/riskModel.js) and the admin dashboard against an admin's own roster    //
// rather than the canned demo one. Unlike seedDemoHistory, generated events   //
// ARE queued for sync (syncedAt: null + a syncQueue row) - the whole point of //
// this button is to show up in both the teacher's own screens AND the admin  //
// overview, which reads from the server.                                     //
// --------------------------------------------------------------------------- //

// Weighted so most students stay green, but every class gets a believable
// handful of amber/red cases to demonstrate the risk model.
const SAMPLE_PROFILE_POOL = ['steady', 'steady', 'steady', 'latecomer', 'wobbling', 'declining'];
function profileForStudent(studentId) {
  return SAMPLE_PROFILE_POOL[hashStr(studentId) % SAMPLE_PROFILE_POOL.length];
}

/**
 * Generate `weeks` weeks of plausible attendance history for every active
 * student in a class. Refuses to run if the class already has any attendance
 * history, local or otherwise - this is a bootstrapping aid for a brand-new
 * class, not a way to backfill or overwrite real records.
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
      // Must be a real UUID - server/src/schemas/attendanceSync.schema.js
      // rejects the whole sync batch otherwise (these rows ARE synced, unlike
      // seedDemoHistory's, so they have to satisfy the same schema real ones do).
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
