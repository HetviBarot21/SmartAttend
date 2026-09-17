/**
 * Server-side absenteeism risk. Two scorers, same as the client
 * (client/src/lib/riskModel.js):
 *   - `scoreRisk` - the original transparent rule-based scorer. Kept as a
 *     fallback/reference.
 *   - `assessStudent` - the real trained model (HistGradientBoosting, 11
 *     features, F1 0.480/0.484 vs the rule-based scorer's 0.350/0.342 - see
 *     ml/results/evaluation_report.json). This is what `getFlaggedStudents`
 *     (db/repository.js) actually calls now. `data/riskModel.json` is the
 *     model's tree ensemble exported to plain arrays
 *     (ml/training/export_model.py) and walked here with ordinary
 *     arithmetic - no Python runtime needed server-side either. Re-export
 *     and copy that file over whenever the model is retrained.
 *
 * Deliberately duplicated from the client rather than shared - client and
 * server already mirror each other's domain logic throughout this codebase
 * (see e.g. client/src/db/database.js vs db/repository.js).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const mlModel = JSON.parse(readFileSync(join(here, '..', 'data', 'riskModel.json'), 'utf8'));

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

  const w1Start = addDays(asOf, -WINDOW_DAYS);
  const w2Start = addDays(asOf, -WINDOW_DAYS * 2);
  const w3Start = addDays(asOf, -WINDOW_DAYS * 3);

  const rate_w1 = windowRate(w1Start, asOf);
  const rate_w2 = windowRate(w2Start, w1Start);
  const rate_w3 = windowRate(w3Start, w2Start);

  const monthDays = schoolDaysBetween(addDays(asOf, -MONTH_DAYS), asOf);
  const isAbsent = (d) => !ATTENDED.has(byDate.get(d));

  let longestStreak = 0;
  let currentStreak = 0;
  let episodes = 0;
  let prevAbsent = false;
  const dowCounts = new Map();
  let totalAbsences = 0;

  for (const d of monthDays) {
    if (isAbsent(d)) {
      currentStreak += 1;
      longestStreak = Math.max(longestStreak, currentStreak);
      if (!prevAbsent) episodes += 1;
      const g = parseISO(d).getDay();
      dowCounts.set(g, (dowCounts.get(g) || 0) + 1);
      totalAbsences += 1;
      prevAbsent = true;
    } else {
      currentStreak = 0;
      prevAbsent = false;
    }
  }

  const maxDow = dowCounts.size ? Math.max(...dowCounts.values()) : 0;
  const dow_concentration = totalAbsences === 0 ? 0 : maxDow / totalAbsences;
  const attendance_trend = rate_w1 === null || rate_w2 === null ? null : rate_w1 - rate_w2;

  return {
    attendance_rate_w1: rate_w1,
    attendance_rate_w2: rate_w2,
    attendance_rate_w3: rate_w3,
    longest_absence_streak: longestStreak,
    absence_episode_count: episodes,
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

// --------------------------------------------------------------------------- //
// trained model                                                               //
// --------------------------------------------------------------------------- //

// Same source and same caveat as the client copy: only 2026 is defined, and
// this needs updating by hand at the start of each school year (it's 3 short
// entries) - ml/training/kenya_calendar.json is the source of truth.
const KENYA_TERMS = [
  { name: 'Term 1 2026', start: '2026-01-05', end: '2026-04-03' },
  { name: 'Term 2 2026', start: '2026-05-04', end: '2026-08-07' },
  { name: 'Term 3 2026', start: '2026-09-01', end: '2026-12-04' },
];

function termContaining(asOf) {
  return KENYA_TERMS.find((t) => t.start <= asOf && asOf <= t.end) ?? null;
}

/**
 * The 4 features beyond the original 7. fee/health absence rate always come
 * back 0 - this server has no absence-reason data (no such column exists),
 * same "no reason data ⇒ 0, not nan" convention the training pipeline uses.
 */
export function computeMlExtraFeatures(history, asOf = toISO(new Date())) {
  const byDate = new Map(history.map((r) => [r.date, r.status]));
  const term = termContaining(asOf);

  let rate_term = null;
  let days_into_term = null;
  if (term) {
    const days = schoolDaysBetween(term.start, asOf);
    days_into_term = days.length;
    rate_term = days.length
      ? days.filter((d) => ATTENDED.has(byDate.get(d))).length / days.length
      : null;
  }

  return { fee_absence_rate: 0, health_absence_rate: 0, attendance_rate_term: rate_term, days_into_term };
}

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

function walkTree(tree, featureVector) {
  let i = 0;
  while (!tree.isLeaf[i]) {
    const v = featureVector[tree.feature[i]];
    const goLeft = v == null || Number.isNaN(v) ? tree.missingLeft[i] : v <= tree.threshold[i];
    i = goLeft ? tree.left[i] : tree.right[i];
  }
  return tree.value[i];
}

export function predictMlProbability(orderedFeatures) {
  let raw = mlModel.baseline;
  for (const tree of mlModel.trees) raw += walkTree(tree, orderedFeatures);
  return sigmoid(raw);
}

export function scoreRiskFromFeatures(allFeatures) {
  const ordered = mlModel.features.map((name) => {
    const v = allFeatures[name];
    return v == null || Number.isNaN(v) ? null : v;
  });
  const dropoutProbability = clip01(predictMlProbability(ordered));
  const flag =
    dropoutProbability >= mlModel.redThreshold
      ? 'red'
      : dropoutProbability >= mlModel.amberThreshold
        ? 'amber'
        : 'green';
  return { score: dropoutProbability, flag, dropoutProbability, overridden: false };
}

/** Score one student's history in a single call, using the trained model. Returns null if not assessable. */
export function assessStudent(history, asOf = toISO(new Date())) {
  if (!isAssessable(history)) return null;
  const features = computeFeatures(history, asOf);
  const extra = computeMlExtraFeatures(history, asOf);
  return { features, ...scoreRiskFromFeatures({ ...features, ...extra }) };
}
