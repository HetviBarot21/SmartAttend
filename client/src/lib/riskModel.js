/**
 * Client-side absenteeism risk — a JS port of the transparent rule-based scorer
 * in `ml/training/train.py` (`RuleBasedScorer`) and the feature windows in
 * `ml/training/feature_engineering.py`.
 *
 * The trained Random Forest (`ml/models/rf_model.pkl`) is the real model, but it
 * runs server-side and isn't wired to the PWA yet. Until it is, the teacher
 * still needs the amber/red flags on the Alerts and Profile screens, so we
 * compute the same seven features and the same weighted score from the
 * attendance history already in IndexedDB. Keep this module free of React and
 * Dexie so it can run in a Web Worker and be unit-tested directly.
 *
 * Feature/label conventions mirror the Python pipeline:
 *   - windows are calendar-time (14 / 28 days) counting only school days;
 *   - a school day is Mon–Fri (the Python side uses the real term calendar —
 *     good enough here, and documented as a known simplification);
 *   - a scheduled school day with no record counts as an absence;
 *   - present + late both count as "attended";
 *   - an attendance rate is null only when a window contains zero school days.
 */

export const FEATURE_NAMES = [
  'attendance_rate_w1',
  'attendance_rate_w2',
  'attendance_rate_w3',
  'longest_absence_streak',
  'absence_episode_count',
  'dow_concentration',
  'attendance_trend',
];

const WEEK = 7;
const WINDOW_DAYS = 14;
const MONTH_DAYS = 28;
const ATTENDED = new Set(['present', 'late']);

/** RuleBasedScorer.WEIGHTS */
export const RISK_WEIGHTS = {
  consecutive: 0.4, // longest_absence_streak
  monthly_rate: 0.3, // 1 - mean(rate_w1, rate_w2)
  day_of_week: 0.15, // dow_concentration
  trend: 0.15, // max(0, -attendance_trend)
};
const CONSECUTIVE_NORM = 5;
const AMBER_THRESHOLD = 0.35;
const RED_THRESHOLD = 0.6;
const OVERRIDE_STREAK = 5;

// --------------------------------------------------------------------------- //
// date helpers — 'YYYY-MM-DD' strings, local time                             //
// --------------------------------------------------------------------------- //

function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function toISO(date) {
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
/** Mon–Fri. getDay(): 0 = Sun … 6 = Sat. */
export function isSchoolDay(iso) {
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

// --------------------------------------------------------------------------- //
// feature engineering                                                         //
// --------------------------------------------------------------------------- //

/**
 * @param {Array<{date: string, status: string}>} history
 * @param {string} asOf  exclusive upper bound ('YYYY-MM-DD'); defaults to today
 * @returns {{[k: string]: number|null}} the 7 features
 */
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
  const w3Start = addDays(asOf, -WINDOW_DAYS * 3);

  const rate_w1 = windowRate(w1Start, w1End);
  const rate_w2 = windowRate(w2Start, w1Start);
  const rate_w3 = windowRate(w3Start, w2Start);

  // absence structure over the current 4-week window
  const monthDays = schoolDaysBetween(addDays(asOf, -MONTH_DAYS), asOf);
  const isAbsent = (d) => !ATTENDED.has(byDate.get(d)); // missing record ⇒ absent

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

  const attendance_trend =
    rate_w1 === null || rate_w2 === null ? null : rate_w1 - rate_w2;

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

/** Recorded school-day observations in the history. */
export function recordedSchoolDays(history) {
  return history.filter((r) => isSchoolDay(r.date) && r.status).length;
}

/** Below this many recorded school days the risk score is not shown. */
export const MIN_ASSESSABLE_DAYS = 8;

/** Whether there is enough recorded history to put a risk flag on a student. */
export function isAssessable(history) {
  return recordedSchoolDays(history) >= MIN_ASSESSABLE_DAYS;
}

// --------------------------------------------------------------------------- //
// scoring — RuleBasedScorer                                                   //
// --------------------------------------------------------------------------- //

const clip01 = (x) => Math.min(1, Math.max(0, x));
const rateOr1 = (v) => (v == null || Number.isNaN(v) ? 1 : v); // missing ⇒ "attended"
const numOr0 = (v) => (v == null || Number.isNaN(v) ? 0 : v);

/**
 * @param {ReturnType<typeof computeFeatures>} f
 * @returns {{
 *   score: number, flag: 'green'|'amber'|'red', dropoutProbability: number,
 *   overridden: boolean,
 *   components: { consecutive: number, monthly_rate: number, day_of_week: number, trend: number }
 * }}
 */
export function scoreRisk(f) {
  const streak = numOr0(f.longest_absence_streak);

  const components = {
    consecutive: clip01(streak / CONSECUTIVE_NORM),
    monthly_rate: clip01(
      1 - (rateOr1(f.attendance_rate_w1) + rateOr1(f.attendance_rate_w2)) / 2
    ),
    day_of_week: clip01(numOr0(f.dow_concentration)),
    trend: clip01(-numOr0(f.attendance_trend)),
  };

  const score =
    RISK_WEIGHTS.consecutive * components.consecutive +
    RISK_WEIGHTS.monthly_rate * components.monthly_rate +
    RISK_WEIGHTS.day_of_week * components.day_of_week +
    RISK_WEIGHTS.trend * components.trend;

  const overridden = streak >= OVERRIDE_STREAK;
  const flag =
    score >= RED_THRESHOLD || overridden ? 'red' : score >= AMBER_THRESHOLD ? 'amber' : 'green';

  // For display only: the rule-based score doubles as a rough dropout-risk %.
  const dropoutProbability = clip01(overridden ? Math.max(score, 0.75) : score);

  return { score, flag, dropoutProbability, overridden, components };
}

/** Human-readable rows for the Profile "Risk Score Breakdown" panel. */
export function breakdownRows(components) {
  return [
    { key: 'day_of_week', label: 'Day pattern', value: components.day_of_week },
    { key: 'consecutive', label: 'Consecutive absences', value: components.consecutive },
    { key: 'monthly_rate', label: 'Monthly rate', value: components.monthly_rate },
    { key: 'trend', label: 'Trend direction', value: components.trend },
  ];
}

// --------------------------------------------------------------------------- //
// 6-week trend                                                                //
// --------------------------------------------------------------------------- //

/**
 * Weekly attendance rate for the `weeks` ISO weeks ending at `asOf`.
 * @returns {Array<{ label: string, weekStart: string, rate: number|null }>}
 */
export function weeklyTrend(history, asOf = toISO(new Date()), weeks = 6) {
  const byDate = new Map(history.map((r) => [r.date, r.status]));
  const out = [];
  for (let i = weeks; i >= 1; i -= 1) {
    const start = addDays(asOf, -WEEK * i);
    const end = addDays(asOf, -WEEK * (i - 1));
    const days = schoolDaysBetween(start, end);
    const rate = days.length
      ? days.filter((d) => ATTENDED.has(byDate.get(d))).length / days.length
      : null;
    out.push({ label: `W${weeks - i + 1}`, weekStart: start, rate });
  }
  return out;
}

// --------------------------------------------------------------------------- //
// narrative — templated from the numbers (stands in for the ML analysis text) //
// --------------------------------------------------------------------------- //

const DOW_LABEL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function dominantAbsenceDay(history, asOf) {
  const byDate = new Map(history.map((r) => [r.date, r.status]));
  const counts = new Map();
  for (const d of schoolDaysBetween(addDays(asOf, -MONTH_DAYS), asOf)) {
    if (!ATTENDED.has(byDate.get(d))) {
      const g = parseISO(d).getDay();
      counts.set(g, (counts.get(g) || 0) + 1);
    }
  }
  let best = null;
  let bestN = 0;
  for (const [g, n] of counts) if (n > bestN) [best, bestN] = [g, n];
  return best == null ? null : { day: DOW_LABEL[best], count: bestN };
}

/**
 * Short bullet insights for the Alerts card body and the Profile ML panel.
 * @returns {string[]}
 */
export function riskInsights(history, features, risk, asOf = toISO(new Date())) {
  const out = [];
  const streak = features.longest_absence_streak;

  if (streak >= 3) {
    const dom = dominantAbsenceDay(history, asOf);
    out.push(
      dom && dom.count >= 2 && features.dow_concentration >= 0.4
        ? `Missed ${streak} consecutive school days, clustered on ${dom.day}s — a recurring weekly disruption pattern.`
        : `Missed ${streak} consecutive school days in the last four weeks.`
    );
  }

  const r1 = features.attendance_rate_w1;
  const r3 = features.attendance_rate_w3;
  if (r1 != null && r3 != null && r3 - r1 >= 0.15) {
    out.push(
      `Attendance dropped from ${Math.round(r3 * 100)}% to ${Math.round(r1 * 100)}% over the last six weeks.`
    );
  } else if (features.attendance_trend != null && features.attendance_trend <= -0.1) {
    out.push('Attendance is trending downward week on week.');
  }

  if (features.absence_episode_count >= 3) {
    out.push(`${features.absence_episode_count} separate absence episodes this month — attendance is fragmenting, not just one bad week.`);
  }

  if (risk.flag === 'red') {
    out.push(
      `~${Math.round(risk.dropoutProbability * 100)}% modelled likelihood of chronic absenteeism without intervention.`
    );
  }

  if (out.length === 0) out.push('Attendance is within the normal range this month.');
  return out;
}

/** One-line summary for the Alerts list (risk domain label + %). */
export function riskHeadline(risk) {
  const pct = Math.round(risk.dropoutProbability * 100);
  return { label: 'Absenteeism risk', pct };
}
