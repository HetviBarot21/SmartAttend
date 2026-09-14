import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assessStudent, isAssessable, MIN_ASSESSABLE_DAYS } from './riskModel.js';

function isoAddDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

/** Build `count` consecutive school-day rows ending `endGapDays` before asOf. */
function schoolDayRows(asOf, { count, status, endGapDays = 0 }) {
  const rows = [];
  let date = isoAddDays(asOf, -endGapDays);
  let made = 0;
  while (made < count) {
    date = isoAddDays(date, -1);
    const dow = new Date(date).getDay();
    if (dow >= 1 && dow <= 5) {
      rows.push({ date, status });
      made += 1;
    }
  }
  return rows;
}

const ASOF = '2026-03-16'; // a Monday

describe('isAssessable', () => {
  test('false below MIN_ASSESSABLE_DAYS of recorded school days', () => {
    const rows = schoolDayRows(ASOF, { count: MIN_ASSESSABLE_DAYS - 1, status: 'present' });
    assert.equal(isAssessable(rows), false);
  });
  test('true at MIN_ASSESSABLE_DAYS', () => {
    const rows = schoolDayRows(ASOF, { count: MIN_ASSESSABLE_DAYS, status: 'present' });
    assert.equal(isAssessable(rows), true);
  });
});

describe('assessStudent', () => {
  test('null when not enough history', () => {
    assert.equal(assessStudent([]), null);
  });

  test('green for a student who is almost always present', () => {
    const rows = schoolDayRows(ASOF, { count: 40, status: 'present' });
    const result = assessStudent(rows, ASOF);
    assert.equal(result.flag, 'green');
  });

  test('red for a student on a long consecutive absence streak', () => {
    // Chain the present block directly onto the absent block's earliest date
    // (rather than guessing a calendar gap) so the two never collide on a date.
    const absentRows = schoolDayRows(ASOF, { count: 6, status: 'absent', endGapDays: 0 });
    const earliestAbsentDate = absentRows[absentRows.length - 1].date;
    const presentRows = schoolDayRows(earliestAbsentDate, { count: 20, status: 'present', endGapDays: 0 });
    const result = assessStudent([...absentRows, ...presentRows], ASOF);
    assert.equal(result.flag, 'red');
    assert.ok(result.dropoutProbability >= 0.6);
  });

  test('amber for a moderate, non-streak absence pattern', () => {
    const rows = schoolDayRows(ASOF, { count: 24, status: 'present' }).map((r, i) => ({
      ...r,
      // scatter isolated absences across the month rather than clustering
      status: i % 4 === 0 ? 'absent' : 'present',
    }));
    const result = assessStudent(rows, ASOF);
    assert.notEqual(result.flag, 'red');
  });
});
