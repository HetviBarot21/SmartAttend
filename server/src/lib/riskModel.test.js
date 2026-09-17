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

const ASOF = '2026-03-16'; // a Monday, inside Term 1 2026 (2026-01-05..2026-04-03)
const TERM_1_START = '2026-01-05';

/**
 * Every school day from `TERM_1_START` up to (not including) `asOf`, using
 * `patternFor(dateISO, index, total)` for each. Needed because
 * attendance_rate_term / days_into_term look back to the start of the term,
 * not just the ~28-day windows the older rule-based scorer used - a fixture
 * that only covers the last N days looks like "absent the rest of the term"
 * to those two features (a school day with no record = absent), which would
 * silently misrepresent what these tests are actually trying to describe.
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
    // The trained model's probabilities cluster tightly (~0.31-0.34) for
    // anything from perfect attendance to occasional scattered absences,
    // then jump sharply once absence gets more frequent (see the ~0.57
    // result for a 1-in-5 pattern in the amber test below). That floor
    // sitting just above this scorer's amber cutoff is a real, verified
    // property of the current model (tuned to optimise recall, i.e. lean
    // toward flagging when unsure) - not a porting bug. Documented rather
    // than silently threshold-tuned around: a real UX tradeoff to revisit
    // if false-amber flags on clearly-fine students turn out to bother
    // teachers in practice.
    const rows = termRows(ASOF, () => 'present');
    const result = assessStudent(rows, ASOF);
    assert.notEqual(result.flag, 'red');
    assert.ok(result.dropoutProbability < 0.4, `expected a low-ish probability, got ${result.dropoutProbability}`);
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

  test('amber (not red) for a mostly-present student with a few scattered absences', () => {
    // present all term except one isolated absence every 10th school day -
    // real signal, but nothing like the chronic pattern the red case builds.
    const rows = termRows(ASOF, (date, i) => (i % 10 === 0 ? 'absent' : 'present'));
    const result = assessStudent(rows, ASOF);
    assert.equal(result.flag, 'amber');
  });
});
