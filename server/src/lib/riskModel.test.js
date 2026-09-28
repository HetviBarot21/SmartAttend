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

const ASOF = '2026-03-16'; // a Monday in Term 1 2026
const TERM_1_START = '2026-01-05';

/**
 * A status for every school day from the start of term to `asOf`. Term
 * features count missing days as absences, so fixtures must cover the whole term.
 */
function termRows(asOf, patternFor) {
  const rows = [];
  let date = TERM_1_START;
  let i = 0;
  while (date < asOf) {
    const dow = new Date(date).getDay();
    if (dow >= 1 && dow <= 5) {
      rows.push({ date, status: patternFor(date, i) });
      i += 1;
    }
    date = isoAddDays(date, 1);
  }
  return rows;
}

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

  test('perfect attendance stays well clear of red, even though the trained model floors around amber', () => {
    // The model scores even perfect attendance around 0.31-0.34, just above
    // the amber cutoff, because its threshold was tuned for recall.
    const rows = termRows(ASOF, () => 'present');
    const result = assessStudent(rows, ASOF);
    assert.notEqual(result.flag, 'red');
    assert.ok(result.dropoutProbability < 0.4, `expected a low-ish probability, got ${result.dropoutProbability}`);
  });

  test('red for a student on a long consecutive absence streak', () => {
    const absentRows = schoolDayRows(ASOF, { count: 6, status: 'absent', endGapDays: 0 });
    const earliestAbsentDate = absentRows[absentRows.length - 1].date;
    const presentRows = schoolDayRows(earliestAbsentDate, { count: 20, status: 'present', endGapDays: 0 });
    const result = assessStudent([...absentRows, ...presentRows], ASOF);
    assert.equal(result.flag, 'red');
    assert.ok(result.dropoutProbability >= 0.6);
  });

  test('amber (not red) for a mostly-present student with a few scattered absences', () => {
    // One absence every 10th school day.
    const rows = termRows(ASOF, (date, i) => (i % 10 === 0 ? 'absent' : 'present'));
    const result = assessStudent(rows, ASOF);
    assert.equal(result.flag, 'amber');
  });
});
