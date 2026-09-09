import {
  computeFeatures,
  scoreRisk,
  weeklyTrend,
  isAssessable,
  isSchoolDay,
  toISO,
} from './riskModel';

/** Build a history of the N school days ending the day before `asOf`. */
function historyEndingBefore(asOf, count, statusFor) {
  const rows = [];
  let d = new Date(asOf);
  d.setDate(d.getDate() - 1);
  while (rows.length < count) {
    const iso = toISO(d);
    if (isSchoolDay(iso)) rows.unshift({ date: iso, status: statusFor(rows.length) });
    d.setDate(d.getDate() - 1);
  }
  return rows;
}

const AS_OF = '2026-09-07'; // a Monday

describe('computeFeatures', () => {
  it('is all-present ⇒ rate 1, no streak, no episodes', () => {
    const history = historyEndingBefore(AS_OF, 30, () => 'present');
    const f = computeFeatures(history, AS_OF);
    expect(f.attendance_rate_w1).toBe(1);
    expect(f.attendance_rate_w2).toBe(1);
    expect(f.longest_absence_streak).toBe(0);
    expect(f.absence_episode_count).toBe(0);
    expect(f.attendance_trend).toBe(0);
  });

  it('counts a missing record on a school day as an absence', () => {
    // only two records, both weeks back ⇒ recent windows are entirely missing
    const f = computeFeatures(
      [{ date: '2026-07-01', status: 'present' }],
      AS_OF
    );
    expect(f.attendance_rate_w1).toBe(0);
    expect(f.longest_absence_streak).toBeGreaterThan(0);
  });

  it('treats late as attended', () => {
    const history = historyEndingBefore(AS_OF, 20, () => 'late');
    expect(computeFeatures(history, AS_OF).attendance_rate_w1).toBe(1);
  });

  it('reports a downward trend when recent weeks are worse', () => {
    const history = historyEndingBefore(AS_OF, 30, (i) => (i < 5 ? 'absent' : 'present'));
    // i counts from the most recent (unshift), so the last 5 school days are absent
    const f = computeFeatures(history, AS_OF);
    expect(f.attendance_trend).toBeLessThan(0);
    expect(f.longest_absence_streak).toBe(5);
  });
});

describe('scoreRisk — parity with the Python RuleBasedScorer', () => {
  it('flags green for a student who always attends', () => {
    const f = computeFeatures(historyEndingBefore(AS_OF, 30, () => 'present'), AS_OF);
    expect(scoreRisk(f).flag).toBe('green');
  });

  it('hard-overrides to red at a 5-day absence streak', () => {
    const f = computeFeatures(
      historyEndingBefore(AS_OF, 30, (i) => (i < 5 ? 'absent' : 'present')),
      AS_OF
    );
    const r = scoreRisk(f);
    expect(f.longest_absence_streak).toBe(5);
    expect(r.overridden).toBe(true);
    expect(r.flag).toBe('red');
    expect(r.dropoutProbability).toBeGreaterThanOrEqual(0.75);
  });

  it('flags amber in the middle band', () => {
    // a recent 3-day absence on top of a patchy month, but no 5-day override
    const f = computeFeatures(
      historyEndingBefore(AS_OF, 28, (i) => (i < 3 || i % 3 === 0 ? 'absent' : 'present')),
      AS_OF
    );
    const r = scoreRisk(f);
    expect(f.longest_absence_streak).toBeLessThan(5);
    expect(r.score).toBeGreaterThanOrEqual(0.35);
    expect(r.score).toBeLessThan(0.6);
    expect(r.flag).toBe('amber');
  });

  it('reads a missing rate feature as "attended", not as risk', () => {
    const r = scoreRisk({
      attendance_rate_w1: null,
      attendance_rate_w2: null,
      longest_absence_streak: 0,
      dow_concentration: 0,
      attendance_trend: null,
    });
    expect(r.score).toBe(0);
    expect(r.flag).toBe('green');
  });
});

describe('weeklyTrend', () => {
  it('returns one point per week, newest last', () => {
    const t = weeklyTrend(historyEndingBefore(AS_OF, 40, () => 'present'), AS_OF, 6);
    expect(t).toHaveLength(6);
    expect(t.map((p) => p.label)).toEqual(['W1', 'W2', 'W3', 'W4', 'W5', 'W6']);
    expect(t.every((p) => p.rate === 1)).toBe(true);
  });
});

describe('isAssessable', () => {
  it('needs at least 8 recorded school days', () => {
    expect(isAssessable(historyEndingBefore(AS_OF, 7, () => 'present'))).toBe(false);
    expect(isAssessable(historyEndingBefore(AS_OF, 8, () => 'present'))).toBe(true);
  });
});
