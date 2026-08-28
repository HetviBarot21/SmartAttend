// Demo roster for the Friday simulation.
//
// Deliberately identical to the client's seed (client/src/db/seedData.js):
// same school, class and student IDs, so a record created by the RFID
// simulation here and a record created by the teacher in the PWA describe the
// same student and can be reconciled during sync.
import { openDatabase } from './index.js';
import { config } from '../config.js';

export const DEMO_SCHOOL = {
  school_id: 'school-kibera-001',
  name: 'Kibera Secondary School',
  county: 'Nairobi',
};

export const DEMO_CLASS = {
  class_group_id: 'class-form3b-001',
  school_id: DEMO_SCHOOL.school_id,
  grade: 'Form 3',
  stream: 'B',
  academic_year: 2026,
};

// student_id matches the client; card_uid is a 4-byte hex UID like a real
// MIFARE Classic card. The simulation only ever emits UIDs from this list.
export const DEMO_STUDENTS = [
  { student_id: 'stu-form3b-001', admission_no: '3B/001', full_name: 'Amina Wanjiru',   card_uid: '04A1B2C3' },
  { student_id: 'stu-form3b-002', admission_no: '3B/002', full_name: 'Brian Kamau',     card_uid: '04D4E5F6' },
  { student_id: 'stu-form3b-003', admission_no: '3B/003', full_name: 'Daniel Mutua',    card_uid: '0417A8B9' },
  { student_id: 'stu-form3b-004', admission_no: '3B/004', full_name: 'Faith Achieng',   card_uid: '04C2D3E4' },
  { student_id: 'stu-form3b-005', admission_no: '3B/005', full_name: 'Grace Muthoni',   card_uid: '0455667788' },
  { student_id: 'stu-form3b-006', admission_no: '3B/006', full_name: 'Jack Otieno',     card_uid: '04998877' },
  { student_id: 'stu-form3b-007', admission_no: '3B/007', full_name: 'Kevin Odhiambo',  card_uid: '04AABBCC' },
  { student_id: 'stu-form3b-008', admission_no: '3B/008', full_name: 'Lydia Chebet',    card_uid: '04DDEEFF' },
  { student_id: 'stu-form3b-009', admission_no: '3B/009', full_name: 'Moses Kipchoge',  card_uid: '04123456' },
  { student_id: 'stu-form3b-010', admission_no: '3B/010', full_name: 'Naomi Waweru',    card_uid: '0478DEF0' },
].map((s) => ({ ...s, class_group_id: DEMO_CLASS.class_group_id, enrolled_at: '2026-01-06' }));

/**
 * Idempotent seed - uses INSERT OR IGNORE / UPDATE so re-running against an
 * already-seeded database repairs it instead of throwing on the primary key.
 * Attendance, challenges and the sync queue are never touched.
 */
export function seed(db) {
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO schools (school_id, name, county) VALUES (@school_id, @name, @county)
       ON CONFLICT(school_id) DO UPDATE SET name = excluded.name, county = excluded.county`
    ).run(DEMO_SCHOOL);

    db.prepare(
      `INSERT INTO class_groups (class_group_id, school_id, grade, stream, academic_year)
       VALUES (@class_group_id, @school_id, @grade, @stream, @academic_year)
       ON CONFLICT(class_group_id) DO UPDATE SET
         grade = excluded.grade, stream = excluded.stream, academic_year = excluded.academic_year`
    ).run(DEMO_CLASS);

    const upsertStudent = db.prepare(
      `INSERT INTO students (student_id, class_group_id, admission_no, full_name, enrolled_at)
       VALUES (@student_id, @class_group_id, @admission_no, @full_name, @enrolled_at)
       ON CONFLICT(student_id) DO UPDATE SET
         admission_no = excluded.admission_no, full_name = excluded.full_name`
    );
    const upsertCard = db.prepare(
      `INSERT INTO rfid_cards (card_uid, student_id) VALUES (@card_uid, @student_id)
       ON CONFLICT(card_uid) DO UPDATE SET student_id = excluded.student_id`
    );

    for (const s of DEMO_STUDENTS) {
      upsertStudent.run(s);
      upsertCard.run({ card_uid: s.card_uid, student_id: s.student_id });
    }
  });
  tx();

  return {
    school: DEMO_SCHOOL.school_id,
    classGroup: DEMO_CLASS.class_group_id,
    students: DEMO_STUDENTS.length,
  };
}

/** The card UIDs the RFID emitter is allowed to fire. */
export const DEMO_CARD_UIDS = DEMO_STUDENTS.map((s) => s.card_uid);

// Run directly: node src/db/seed.js
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('seed.js')) {
  const db = openDatabase();
  const result = seed(db);
  console.log(`Seeded ${config.dbPath}`);
  console.log(result);
  db.close();
}
