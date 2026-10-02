import { parseHash, toHash } from './useHashRoute';

describe('hash routes', () => {
  it('parses tab, student and class pages', () => {
    expect(parseHash('#/register')).toEqual({ tab: 'attendance', studentId: null, classId: null });
    expect(parseHash('#/at-risk/student/stu-007')).toEqual({ tab: 'alerts', studentId: 'stu-007', classId: null });
    expect(parseHash('#/school/class/c-1')).toEqual({ tab: 'overview', studentId: null, classId: 'c-1' });
  });

  it('falls back to the dashboard for empty or unknown hashes', () => {
    expect(parseHash('').tab).toBe('dashboard');
    expect(parseHash('#/nope').tab).toBe('dashboard');
  });

  it('round-trips through toHash', () => {
    const route = { tab: 'heatmap', studentId: 'a b', classId: null };
    expect(toHash(route)).toBe('#/reports/student/a%20b');
    expect(parseHash(toHash(route))).toEqual(route);
  });
});
