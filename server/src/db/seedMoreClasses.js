/**
 * Adds a couple more classes, each with a different teacher, under
 * LOCAL_SCHOOL_ID ('school-local-001' - see client/src/db/database.js).
 *
 * The demo roster in db/seed.js lives under 'school-kibera-001' and is fed by
 * the RFID simulation. A real admin session in the PWA (local auth mode, no
 * Cognito pool) always reports schoolId 'school-local-001' instead - the same
 * id every teacher's device pushes its own classes under. So *this* is the
 * school an admin actually sees in the Overview tab when signed in through
 * the app, and it needs more than one class/teacher in it to be worth
 * looking at. Idempotent (safe to re-run) and additive - does not touch the
 * Kibera demo roster or anything a real device has pushed here.
 *
 * Run directly: node src/db/seedMoreClasses.js   (no npm script - one-off demo aid)
 */
import { openDatabase } from './index.js';
import { upsertSchool, upsertClassGroup, upsertStudent, recordAttendance } from './repository.js';

const SCHOOL_ID = 'school-local-001';
const SCHOOL_NAME = 'Kibera Secondary School';

const CLASSES = [
  {
    classGroupId: 'class-form1a-001',
    grade: 'Form 1',
    stream: 'A',
    teacherName: 'Grace Njoroge',
    students: [
      { id: 'stu-form1a-001', admissionNo: '1A/001', name: 'Beatrice Nyambura', profile: 'steady' },
      { id: 'stu-form1a-002', admissionNo: '1A/002', name: 'Collins Mutiso', profile: 'steady' },
      { id: 'stu-form1a-003', admissionNo: '1A/003', name: 'Dennis Kiptoo', profile: 'latecomer' },
      { id: 'stu-form1a-004', admissionNo: '1A/004', name: 'Esther Adhiambo', profile: 'steady' },
      { id: 'stu-form1a-005', admissionNo: '1A/005', name: 'Fredrick Omondi', profile: 'declining' },
      { id: 'stu-form1a-006', admissionNo: '1A/006', name: 'Ivy Chepkoech', profile: 'steady' },
      { id: 'stu-form1a-007', admissionNo: '1A/007', name: 'Joseph Mwangi', profile: 'wobbling' },
      { id: 'stu-form1a-008', admissionNo: '1A/008', name: 'Mercy Akinyi', profile: 'steady' },
    ],
  },
  {
    classGroupId: 'class-form4d-001',
    grade: 'Form 4',
    stream: 'D',
    teacherName: 'Peter Kamau',
    students: [
      { id: 'stu-form4d-001', admissionNo: '4D/001', name: 'Alfred Njuguna', profile: 'steady' },
      { id: 'stu-form4d-002', admissionNo: '4D/002', name: 'Catherine Wairimu', profile: 'latecomer' },
      { id: 'stu-form4d-003', admissionNo: '4D/003', name: 'Duncan Cheruiyot', profile: 'steady' },
      { id: 'stu-form4d-004', admissionNo: '4D/004', name: 'Faith Nekesa', profile: 'wobbling' },
      { id: 'stu-form4d-005', admissionNo: '4D/005', name: 'George Onyango', profile: 'steady' },
      { id: 'stu-form4d-006', admissionNo: '4D/006', name: 'Hellen Wanjala', profile: 'declining' },
      { id: 'stu-form4d-007', admissionNo: '4D/007', name: 'Isaac Barasa', profile: 'steady' },
    ],
  },
];

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

function schoolDaysBack(weeks, today) {
  const todayIso = todayISO(today);
  const g = new Date(todayIso).getDay();
  const monday = isoAddDays(todayIso, -(g === 0 ? 6 : g - 1) - weeks * 7);
  const days = [];
  for (let d = 0; d < (weeks + 1) * 7; d += 1) {
    const date = isoAddDays(monday, d);
    if (date >= todayIso) break;
    const dow = new Date(date).getDay();
    if (dow >= 1 && dow <= 5) days.push(date);
  }
  return days;
}

export function seedMoreClasses(db, today = new Date()) {
  upsertSchool(db, { schoolId: SCHOOL_ID, name: SCHOOL_NAME });

  const schoolDays = schoolDaysBack(HISTORY_WEEKS, today);
  const total = schoolDays.length;
  let classesAdded = 0;
  let studentsAdded = 0;
  let recordsAdded = 0;

  for (const cls of CLASSES) {
    upsertClassGroup(db, {
      classGroupId: cls.classGroupId,
      schoolId: SCHOOL_ID,
      grade: cls.grade,
      stream: cls.stream,
      academicYear: today.getFullYear(),
      teacherName: cls.teacherName,
    });
    classesAdded += 1;

    for (const s of cls.students) {
      upsertStudent(db, {
        studentId: s.id,
        classGroupId: cls.classGroupId,
        admissionNo: s.admissionNo,
        fullName: s.name,
        enrolledAt: schoolDays[0],
      });
      studentsAdded += 1;

      const already = db.prepare('SELECT COUNT(*) AS n FROM attendance_events WHERE student_id = ?').get(s.id).n;
      if (already > 0) continue; // idempotent - don't duplicate history on re-run

      const profile = PROFILES[s.profile] ?? PROFILES.steady;
      schoolDays.forEach((date, idx) => {
        const rand = mulberry32(hashStr(`${s.id}:${date}`))();
        const status = profile({ rand, fromEnd: total - idx });
        recordAttendance(db, { studentId: s.id, date, status, captureMethod: 'import', source: 'simulation' });
        recordsAdded += 1;
      });
    }
  }

  return { schoolId: SCHOOL_ID, classesAdded, studentsAdded, recordsAdded };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('seedMoreClasses.js')) {
  const db = openDatabase();
  console.log(seedMoreClasses(db));
  db.close();
}
