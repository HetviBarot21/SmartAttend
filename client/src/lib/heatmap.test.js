import { startOfWeek, schoolWeek, buildWeeklyHeatmap } from './heatmap';

describe('startOfWeek', () => {
  it('returns the Monday of the containing week', () => {
    expect(startOfWeek('2026-09-09')).toBe('2026-09-07'); // Wed → Mon
    expect(startOfWeek('2026-09-07')).toBe('2026-09-07'); // Mon → itself
    expect(startOfWeek('2026-09-13')).toBe('2026-09-07'); // Sun → previous Mon
  });
});

describe('schoolWeek', () => {
  it('is the five weekdays Mon–Fri', () => {
    const days = schoolWeek('2026-09-07');
    expect(days.map((d) => d.date)).toEqual([
      '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11',
    ]);
    expect(days.map((d) => d.label)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
  });
});

describe('buildWeeklyHeatmap', () => {
  const students = [
    { studentId: 's1', fullName: 'Ann A' },
    { studentId: 's2', fullName: 'Ben B' },
  ];

  it('fills missing past school days as absent and rates the graded days', () => {
    const records = [
      { studentId: 's1', date: '2026-09-07', status: 'present' },
      { studentId: 's1', date: '2026-09-08', status: 'late' },
      { studentId: 's1', date: '2026-09-09', status: 'absent' },
      // s1 09-10 missing ⇒ absent; 09-11 is "today" and unmarked ⇒ not graded
    ];
    const { rows, classAverage } = buildWeeklyHeatmap(students, records, '2026-09-07', '2026-09-11');
    const s1 = rows.find((r) => r.student.studentId === 's1');
    expect(s1.cells.map((c) => c.status)).toEqual(['present', 'late', 'absent', 'absent', 'upcoming']);
    expect(s1.rate).toBeCloseTo(2 / 4);
    const s2 = rows.find((r) => r.student.studentId === 's2');
    expect(s2.rate).toBe(0); // no records at all across the four past days
    expect(classAverage).toBeCloseTo((2 / 4 + 0) / 2);
  });

  it('marks today (until marked) and future days as not-yet-graded', () => {
    const { rows } = buildWeeklyHeatmap(students, [], '2026-09-07', '2026-09-08');
    const statuses = rows[0].cells.map((c) => c.status);
    expect(statuses).toEqual(['absent', 'upcoming', 'upcoming', 'upcoming', 'upcoming']);
    expect(rows[0].rate).toBeCloseTo(0); // only Monday is graded
  });
});
