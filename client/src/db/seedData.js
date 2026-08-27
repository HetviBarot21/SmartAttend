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
 * Idempotent seed. Uses put() rather than add() so re-running against a
 * partially seeded database repairs it instead of throwing on the unique index.
 */
export async function seedDatabase() {
  const existing = await db.students.where('classGroupId').equals(DEMO_CLASS_ID).count();
  if (existing === DEMO_STUDENTS.length) return { seeded: false };

  await db.transaction('rw', db.classGroups, db.students, async () => {
    const cls = await db.classGroups.where('classGroupId').equals(DEMO_CLASS_ID).first();
    if (!cls) await db.classGroups.add(DEMO_CLASS);

    for (const student of DEMO_STUDENTS) {
      const found = await db.students.where('studentId').equals(student.studentId).first();
      if (found) await db.students.update(found.id, student);
      else await db.students.add(student);
    }
  });

  return { seeded: true, count: DEMO_STUDENTS.length };
}
