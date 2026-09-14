import { db, createClass, addStudent, getClassHistory } from './database';
import { generateSampleHistory } from './seedData';

beforeEach(async () => {
  if (db.isOpen()) db.close();
  await db.delete();
  await db.open();
});

afterAll(async () => {
  if (db.isOpen()) db.close();
  await db.delete();
});

async function makeClassWithStudents(n) {
  const cls = await createClass({ grade: 'Form 2', stream: 'A' });
  const students = [];
  for (let i = 0; i < n; i += 1) {
    students.push(await addStudent({ classGroupId: cls.classGroupId, fullName: `Student ${i}` }));
  }
  return { cls, students };
}

describe('generateSampleHistory', () => {
  it('refuses to run for a class with no students', async () => {
    const cls = await createClass({ grade: 'Form 1' });
    const result = await generateSampleHistory(cls.classGroupId);
    expect(result.seeded).toBe(false);
    expect(result.reason).toMatch(/no students/);
  });

  it('generates weekday-only history for every student and queues it for sync', async () => {
    const { cls, students } = await makeClassWithStudents(6);
    const result = await generateSampleHistory(cls.classGroupId, { weeks: 4 });

    expect(result.seeded).toBe(true);
    expect(result.studentCount).toBe(6);

    const rows = await getClassHistory(cls.classGroupId, '2000-01-01');
    expect(rows.length).toBe(result.count);
    for (const row of rows) {
      const dow = new Date(row.date).getDay();
      expect(dow).toBeGreaterThanOrEqual(1);
      expect(dow).toBeLessThanOrEqual(5);
      expect(['present', 'absent', 'late']).toContain(row.status);
    }

    // Queued for the normal outbound attendance sync, unlike seedDemoHistory's
    // "already reconciled" demo rows - that's the whole point of this button.
    const queued = await db.syncQueue.where('status').equals('pending').count();
    expect(queued).toBe(rows.length);

    // Sanity check the mix isn't degenerate (some risk to show, not all-present).
    const statuses = new Set(rows.map((r) => r.status));
    expect(statuses.has('absent') || statuses.has('late')).toBe(true);

    void students;
  });

  it('refuses to overwrite a class that already has attendance history', async () => {
    const { cls } = await makeClassWithStudents(2);
    const first = await generateSampleHistory(cls.classGroupId);
    expect(first.seeded).toBe(true);

    const second = await generateSampleHistory(cls.classGroupId);
    expect(second.seeded).toBe(false);
    expect(second.reason).toMatch(/already has attendance history/);
  });

  it('is deterministic for a given student roster and "today"', async () => {
    const { cls } = await makeClassWithStudents(4);
    const today = new Date(2026, 5, 15);
    await generateSampleHistory(cls.classGroupId, { weeks: 3, today });
    const first = (await getClassHistory(cls.classGroupId, '2000-01-01')).map((r) => `${r.studentId}:${r.date}:${r.status}`);

    await db.attendanceEvents.clear();
    await db.syncQueue.clear();
    await generateSampleHistory(cls.classGroupId, { weeks: 3, today });
    const second = (await getClassHistory(cls.classGroupId, '2000-01-01')).map((r) => `${r.studentId}:${r.date}:${r.status}`);

    expect(second).toEqual(first);
  });
});
