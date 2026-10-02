import { startOfWeek, schoolWeek, buildWeeklyHeatmap, monthBounds, schoolDaysInRange, buildRegisterGrid } from './heatmap';

describe('startOfWeek', () => {
  it('returns the Monday of the containing week', () => {
    expect(startOfWeek('2026-09-09')).toBe('2026-09-07'); // Wed → Mon
    expect(startOfWeek('2026-09-07')).toBe('2026-09-07'); // Mon → itself
    expect(startOfWeek('2026-09-13')).toBe('2026-09-07'); // Sun → previous Mon
  });
});

describe('schoolWeek', () => {
  it('is the five weekdays Mon-Fri', () => {
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
      // s1 09-10 missing means absent; 09-11 is today and unmarked, so not graded
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

describe('monthBounds / schoolDaysInRange', () => {
  it('covers the whole month and keeps only weekdays', () => {
    expect(monthBounds('2026-09-16')).toEqual({ start: '2026-09-01', end: '2026-09-30' });
    const days = schoolDaysInRange('2026-09-01', '2026-09-30');
    expect(days).toHaveLength(22);
    expect(days[0]).toEqual({ date: '2026-09-01', label: 'Tue' });
    expect(days.some((d) => d.date === '2026-09-05')).toBe(false); // Saturday
  });
});

describe('buildRegisterGrid', () => {
  it('counts present, late and absent per student', () => {
    const students = [{ studentId: 's1', fullName: 'Ann A' }];
    const records = [
      { studentId: 's1', date: '2026-09-07', status: 'present' },
      { studentId: 's1', date: '2026-09-08', status: 'late' },
    ];
    const days = schoolDaysInRange('2026-09-07', '2026-09-09');
    const { rows } = buildRegisterGrid(students, records, days, '2026-09-10');
    expect(rows[0].totals).toEqual({ present: 1, late: 1, absent: 1 });
    expect(rows[0].rate).toBeCloseTo(2 / 3);
  });
});
