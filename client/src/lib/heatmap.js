/**
 * Weekly attendance grid for the Heatmap screen. Uses the same conventions as
 * lib/riskModel.js: school days are Mon-Fri, a missing record is an absence,
 * and late counts as attended.
 */

import { toISO, isSchoolDay } from './riskModel';

const WEEKDAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDays(iso, n) {
  const dt = parseISO(iso);
  dt.setDate(dt.getDate() + n);
  return toISO(dt);
}

/** Monday of the ISO week containing `iso`. */
export function startOfWeek(iso = toISO(new Date())) {
  const dt = parseISO(iso);
  const g = dt.getDay(); // 0 Sun … 6 Sat
  const backToMonday = g === 0 ? 6 : g - 1;
  return addDays(iso, -backToMonday);
}

/** The five school days of the week starting at `weekStartISO`. */
export function schoolWeek(weekStartISO) {
  const days = [];
  for (let i = 0; i < 7 && days.length < 5; i += 1) {
    const d = addDays(weekStartISO, i);
    if (isSchoolDay(d)) days.push({ date: d, label: WEEKDAY_LABEL[parseISO(d).getDay()] });
  }
  return days;
}

/** First and last calendar day of the month containing `iso`. */
export function monthBounds(iso = toISO(new Date())) {
  const dt = parseISO(iso);
  const first = new Date(dt.getFullYear(), dt.getMonth(), 1);
  const last = new Date(dt.getFullYear(), dt.getMonth() + 1, 0);
  return { start: toISO(first), end: toISO(last) };
}

/** School days from `startISO` to `endISO`, both inclusive. */
export function schoolDaysInRange(startISO, endISO) {
  const days = [];
  for (let d = startISO; d <= endISO; d = addDays(d, 1)) {
    if (isSchoolDay(d)) days.push({ date: d, label: WEEKDAY_LABEL[parseISO(d).getDay()] });
  }
  return days;
}

/**
 * Register grid over any list of school days.
 *
 * @param {Array<{studentId: string, fullName: string, admissionNo?: string}>} students
 * @param {Array<{studentId: string, date: string, status: string}>} records
 * @param {Array<{date: string, label: string}>} days
 * @param {string} [today]  cells after this are shown as "upcoming", not absent
 */
export function buildRegisterGrid(students, records, days, today = toISO(new Date())) {
  const byKey = new Map(records.map((r) => [`${r.studentId}|${r.date}`, r.status]));

  const rows = students.map((student) => {
    const cells = days.map((day) => {
      const status = byKey.get(`${student.studentId}|${day.date}`) ?? null;
      // Future days, and today until marked, do not count as absences.
      const pending = day.date > today || (day.date === today && status == null);
      return {
        date: day.date,
        label: day.label,
        status: pending ? 'upcoming' : status ?? 'absent',
        recorded: status != null,
      };
    });
    const totals = { present: 0, late: 0, absent: 0 };
    for (const c of cells) if (c.status in totals) totals[c.status] += 1;
    const graded = totals.present + totals.late + totals.absent;
    const rate = graded ? (totals.present + totals.late) / graded : null;
    return { student, cells, rate, totals };
  });

  const rated = rows.map((r) => r.rate).filter((r) => r != null);
  const classAverage = rated.length ? rated.reduce((a, b) => a + b, 0) / rated.length : null;

  return { days, rows, classAverage };
}

/** Weekly grid for the week starting at `weekStartISO` (a Monday). */
export function buildWeeklyHeatmap(students, records, weekStartISO, today = toISO(new Date())) {
  return buildRegisterGrid(students, records, schoolWeek(weekStartISO), today);
}

export const HEATMAP_LEGEND = [
  { key: 'present', label: 'Present' },
  { key: 'late', label: 'Late' },
  { key: 'absent', label: 'Absent' },
  { key: 'excused', label: 'Excused' },
];
