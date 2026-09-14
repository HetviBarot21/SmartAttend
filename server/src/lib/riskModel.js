/**
 * Server-side port of the same rule-based absenteeism scorer as
 * `client/src/lib/riskModel.js` (itself a port of `RuleBasedScorer` in
 * `ml/training/train.py`). Kept deliberately duplicated rather than shared -
 * client and server already mirror each other's domain logic throughout this
 * codebase (see e.g. `client/src/db/database.js` vs `db/repository.js`).
 *
 * Used by `getFlaggedStudents` (db/repository.js) so the admin endpoints can
 * compute risk flags directly from `attendance_events` without a live ML
 * inference service (the trained RF pickle in ml/models/ isn't wired to an
 * endpoint - see PROJECT_CONTEXT.md).
 */

const WINDOW_DAYS = 14;
const MONTH_DAYS = 28;
const ATTENDED = new Set(['present', 'late']);

const WEIGHTS = { consecutive: 0.4, monthly_rate: 0.3, day_of_week: 0.15, trend: 0.15 };
const CONSECUTIVE_NORM = 5;
const AMBER_THRESHOLD = 0.35;
const RED_THRESHOLD = 0.6;
const OVERRIDE_STREAK = 5;

/** A flag is "fresh" (no new follow-up needed yet) if logged within this many days. */
export const FOLLOW_UP_FRESH_DAYS = 14;

/** Minimum recorded school days before a flag is shown at all. */
export const MIN_ASSESSABLE_DAYS = 8;

function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function toISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function addDays(iso, n) {
  const dt = parseISO(iso);
  dt.setDate(dt.getDate() + n);
  return toISO(dt);
}
function isSchoolDay(iso) {
  const g = parseISO(iso).getDay();
  return g >= 1 && g <= 5;
}
function schoolDaysBetween(startISO, endISO) {
  const out = [];
  for (let d = startISO; d < endISO; d = addDays(d, 1)) {
    if (isSchoolDay(d)) out.push(d);
  }
  return out;
}

/** @param {Array<{date:string, status:string}>} history */
export function computeFeatures(history, asOf = toISO(new Date())) {
  const byDate = new Map(history.map((r) => [r.date, r.status]));

  const windowRate = (startISO, endISO) => {
    const days = schoolDaysBetween(startISO, endISO);
    if (days.length === 0) return null;
    const attended = days.filter((d) => ATTENDED.has(byDate.get(d))).length;
    return attended / days.length;
  };

  const w1End = asOf;
  const w1Start = addDays(asOf, -WINDOW_DAYS);
  const w2Start = addDays(asOf, -WINDOW_DAYS * 2);

  const rate_w1 = windowRate(w1Start, w1End);
  const rate_w2 = windowRate(w2Start, w1Start);

  const monthDays = schoolDaysBetween(addDays(asOf, -MONTH_DAYS), asOf);
  const isAbsent = (d) => !ATTENDED.has(byDate.get(d));

  let longestStreak = 0;
  let currentStreak = 0;
  let prevAbsent = false;
  const dowCounts = new Map();
  let totalAbsences = 0;

  for (const d of monthDays) {
    if (isAbsent(d)) {
      currentStreak += 1;
      longestStreak = Math.max(longestStreak, currentStreak);
      const g = parseISO(d).getDay();
      dowCounts.set(g, (dowCounts.get(g) || 0) + 1);
      totalAbsences += 1;
      prevAbsent = true;
    } else {
      currentStreak = 0;
      prevAbsent = false;
    }
  }
  void prevAbsent;

  const maxDow = dowCounts.size ? Math.max(...dowCounts.values()) : 0;
  const dow_concentration = totalAbsences === 0 ? 0 : maxDow / totalAbsences;
  const attendance_trend = rate_w1 === null || rate_w2 === null ? null : rate_w1 - rate_w2;

  return {
    attendance_rate_w1: rate_w1,
    attendance_rate_w2: rate_w2,
    longest_absence_streak: longestStreak,
    dow_concentration,
    attendance_trend,
  };
}

export function recordedSchoolDays(history) {
  return history.filter((r) => isSchoolDay(r.date) && r.status).length;
}

export function isAssessable(history) {
  return recordedSchoolDays(history) >= MIN_ASSESSABLE_DAYS;
}

const clip01 = (x) => Math.min(1, Math.max(0, x));
const rateOr1 = (v) => (v == null || Number.isNaN(v) ? 1 : v);
const numOr0 = (v) => (v == null || Number.isNaN(v) ? 0 : v);

export function scoreRisk(f) {
  const streak = numOr0(f.longest_absence_streak);

  const components = {
    consecutive: clip01(streak / CONSECUTIVE_NORM),
    monthly_rate: clip01(1 - (rateOr1(f.attendance_rate_w1) + rateOr1(f.attendance_rate_w2)) / 2),
    day_of_week: clip01(numOr0(f.dow_concentration)),
    trend: clip01(-numOr0(f.attendance_trend)),
  };

  const score =
    WEIGHTS.consecutive * components.consecutive +
    WEIGHTS.monthly_rate * components.monthly_rate +
    WEIGHTS.day_of_week * components.day_of_week +
    WEIGHTS.trend * components.trend;

  const overridden = streak >= OVERRIDE_STREAK;
  const flag = score >= RED_THRESHOLD || overridden ? 'red' : score >= AMBER_THRESHOLD ? 'amber' : 'green';
  const dropoutProbability = clip01(overridden ? Math.max(score, 0.75) : score);

  return { score, flag, dropoutProbability, overridden };
}

/** Score one student's history in a single call. Returns null if not assessable. */
export function assessStudent(history, asOf = toISO(new Date())) {
  if (!isAssessable(history)) return null;
  const features = computeFeatures(history, asOf);
  return { features, ...scoreRisk(features) };
}
