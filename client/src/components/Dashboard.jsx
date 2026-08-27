import { useEffect, useState } from 'react';
import { getStudentsByClass, getAttendanceForDate, todayISO } from '../db/database';
import { summariseDay, absentStudents, formatLongDate } from '../lib/attendanceSummary';

const LABELS = { present: 'Present', absent: 'Absent', late: 'Late', unmarked: 'Not marked' };

export default function Dashboard({ classGroupId, refreshKey }) {
  const date = todayISO();
  const [summary, setSummary] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [students, records] = await Promise.all([
        getStudentsByClass(classGroupId),
        getAttendanceForDate(classGroupId, date)
      ]);
      if (!cancelled) setSummary(summariseDay(students, records));
    })();
    return () => { cancelled = true; };
  }, [classGroupId, date, refreshKey]);

  if (!summary) return <p className="empty">Loading summary…</p>;

  const absentees = absentStudents(summary);
  const pct = (n) => (summary.marked === 0 ? 0 : (n / summary.marked) * 100);

  return (
    <section>
      <div className="card">
        <h2 className="card__title">Today's attendance</h2>
        <p className="card__hint">{formatLongDate(date)}</p>

        <div className="stats">
          <div className="stat stat--present">
            <div className="stat__value">{summary.present}</div>
            <div className="stat__label">Present</div>
          </div>
          <div className="stat stat--late">
            <div className="stat__value">{summary.late}</div>
            <div className="stat__label">Late</div>
          </div>
          <div className="stat stat--absent">
            <div className="stat__value">{summary.absent}</div>
            <div className="stat__label">Absent</div>
          </div>
          <div className="stat stat--rate">
            <div className="stat__value">
              {summary.attendanceRate === null ? '—' : `${summary.attendanceRate}%`}
            </div>
            <div className="stat__label">Rate</div>
          </div>
        </div>

        {summary.marked > 0 && (
          <div className="meter" role="img"
            aria-label={`${summary.present} present, ${summary.late} late, ${summary.absent} absent of ${summary.marked} marked`}>
            <div className="meter__seg--present" style={{ width: `${pct(summary.present)}%` }} />
            <div className="meter__seg--late" style={{ width: `${pct(summary.late)}%` }} />
            <div className="meter__seg--absent" style={{ width: `${pct(summary.absent)}%` }} />
          </div>
        )}

        {!summary.complete && (
          <div className="notice notice--warn" style={{ marginTop: 14, marginBottom: 0 }} role="status">
            {summary.unmarked} of {summary.total} student(s) not yet marked today.
          </div>
        )}
      </div>

      <div className="card">
        <h2 className="card__title">Absent today</h2>
        <p className="card__hint">
          {/* Sprint 4 replaces this plain list with risk-scored amber/red flags (US-02). */}
          Students to follow up on
        </p>
        {absentees.length === 0 ? (
          <p className="empty">
            {summary.marked === 0 ? 'No attendance recorded yet today.' : 'No absences recorded today.'}
          </p>
        ) : (
          <ul className="list">
            {absentees.map((s) => (
              <li key={s.studentId} className="list__item">
                <span>{s.fullName} <span className="roll__adm">· {s.admissionNo}</span></span>
                <span className="pill pill--absent">Absent</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <h2 className="card__title">Class roll</h2>
        <p className="card__hint">{summary.marked} of {summary.total} marked</p>
        <ul className="list">
          {summary.rows.map((s) => (
            <li key={s.studentId} className="list__item">
              <span>{s.fullName}</span>
              <span className={`pill pill--${s.status ?? 'unmarked'}`}>
                {LABELS[s.status ?? 'unmarked']}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
