/**
 * Daily attendance aggregation.
 *
 * Kept free of React and Dexie so the Friday-demo dashboard numbers can be
 * unit-tested directly, and so Sprint 4's risk engine can reuse it inside a
 * Web Worker where neither the DOM nor Dexie is available.
 */

export const PRESENT_STATUSES = ['present', 'late'];

/**
 * @param {Array<{studentId: string, fullName: string}>} students - the full class roll
 * @param {Array<{studentId: string, status: string}>} records - records for one date
 */
export function summariseDay(students, records) {
  const byStudent = new Map();
  for (const r of records) byStudent.set(r.studentId, r);

  const counts = { present: 0, absent: 0, late: 0, unmarked: 0 };
  const rows = students.map((student) => {
    const status = byStudent.get(student.studentId)?.status ?? null;
    if (status && status in counts) counts[status] += 1;
    else counts.unmarked += 1;
    return { ...student, status };
  });

  const total = students.length;
  const marked = total - counts.unmarked;
  // Late students were in school, so they count towards attendance rate.
  const inSchool = counts.present + counts.late;

  return {
    total,
    marked,
    ...counts,
    complete: total > 0 && counts.unmarked === 0,
    // Rate is over students actually marked - a half-finished roll call should
    // not read as 50% attendance on the dashboard.
    attendanceRate: marked === 0 ? null : Math.round((inSchool / marked) * 1000) / 10,
    rows
  };
}

/** Students needing teacher attention today. Sprint 4 replaces this with the risk engine. */
export function absentStudents(summary) {
  return summary.rows.filter((r) => r.status === 'absent');
}

export function formatLongDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
}
