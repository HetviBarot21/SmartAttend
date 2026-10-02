import { useMemo, useState } from 'react';
import { todayISO } from '../db/database';
import { riskHeadline, isSchoolDay, toISO } from '../lib/riskModel';
import { formatLongDate } from '../lib/attendanceSummary';
import { useClassRisk } from '../hooks/useClassRisk';
import Avatar from './Avatar';
import { ArrowRightIcon, CheckCircleIcon, AlertTriangleIcon } from './icons';

const ATTENDED = new Set(['present', 'late']);
const CHART_DAYS = 10;

function lastSchoolDays(n, endISO) {
  const out = [];
  const [y, m, d] = endISO.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  while (out.length < n) {
    const iso = toISO(dt);
    if (isSchoolDay(iso)) out.unshift(iso);
    dt.setDate(dt.getDate() - 1);
  }
  return out;
}

function shortDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' });
}

/** Daily attendance rate as vertical bars. Days with no register taken are left empty. */
function RateChart({ days }) {
  const [hover, setHover] = useState(null);
  const h = 160;
  return (
    <div className="ratechart">
      <div className="ratechart__plot" style={{ height: h }}>
        {[100, 75, 50, 25].map((g) => (
          <div key={g} className="ratechart__grid" style={{ bottom: `${g}%` }}>
            <span>{g}%</span>
          </div>
        ))}
        <div className="ratechart__bars">
          {days.map((d, i) => (
            <div
              key={d.date}
              className="ratechart__col"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              tabIndex={0}
              aria-label={`${shortDay(d.date)}: ${d.rate == null ? 'no register' : `${Math.round(d.rate * 100)}% attended`}`}
            >
              {d.rate != null && (
                <div
                  className={`ratechart__bar${d.rate < 0.85 ? ' ratechart__bar--low' : ''}`}
                  style={{ height: `${Math.max(d.rate * 100, 2)}%` }}
                />
              )}
              {hover === i && (
                <div className="ratechart__tip" role="tooltip">
                  <b>{shortDay(d.date)}</b>
                  {d.rate == null ? 'No register taken' : (
                    <>
                      <span>{Math.round(d.rate * 100)}% attended</span>
                      <span>{d.present} present · {d.late} late · {d.absent} absent</span>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="ratechart__axis">
        {days.map((d) => <span key={d.date}>{shortDay(d.date)}</span>)}
      </div>
    </div>
  );
}

export default function Dashboard({ classGroupId, className, onTakeAttendance, onOpenAlerts, onOpenProfile }) {
  const { loading, students, history, flagged } = useClassRisk(classGroupId);
  const today = todayISO();

  const { todayStats, chartDays, termRate } = useMemo(() => {
    const byDate = new Map();
    for (const r of history) {
      if (!byDate.has(r.date)) byDate.set(r.date, { present: 0, late: 0, absent: 0 });
      byDate.get(r.date)[r.status] += 1;
    }
    const stat = (date) => {
      const s = byDate.get(date);
      if (!s) return { date, rate: null, present: 0, late: 0, absent: 0, marked: 0 };
      const marked = s.present + s.late + s.absent;
      return { date, ...s, marked, rate: marked ? (s.present + s.late) / marked : null };
    };
    const attended = history.filter((r) => ATTENDED.has(r.status)).length;
    return {
      todayStats: stat(today),
      chartDays: lastSchoolDays(CHART_DAYS, today).map(stat),
      termRate: history.length ? attended / history.length : null,
    };
  }, [history, today]);

  if (loading) return <p className="empty">Loading dashboard…</p>;

  const unmarked = students.length - todayStats.marked;
  const red = flagged.filter((f) => f.risk.flag === 'red').length;
  const absentToday = history
    .filter((r) => r.date === today && r.status === 'absent')
    .map((r) => students.find((s) => s.studentId === r.studentId))
    .filter(Boolean);

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">Dashboard</h2>
          <p className="page-head__sub">{className} · {formatLongDate(today)}</p>
        </div>
        <div className="page-head__actions">
          <button type="button" className="btn btn--sm" onClick={onTakeAttendance}>
            <CheckCircleIcon size={16} />
            Take attendance
          </button>
        </div>
      </div>

      {isSchoolDay(today) && unmarked > 0 && (
        <div className="callout">
          <AlertTriangleIcon size={18} />
          <span>
            {todayStats.marked === 0
              ? "Today's register has not been taken yet."
              : `${unmarked} student${unmarked === 1 ? '' : 's'} still not marked today.`}
          </span>
          <button type="button" className="linkbtn" onClick={onTakeAttendance}>Open register</button>
        </div>
      )}

      <div className="kpis">
        <div className="kpi">
          <span className="kpi__label">Attendance today</span>
          <span className="kpi__value">{todayStats.rate == null ? '-' : `${Math.round(todayStats.rate * 100)}%`}</span>
          <span className="kpi__sub">{todayStats.marked} of {students.length} marked</span>
        </div>
        <div className="kpi">
          <span className="kpi__label"><span className="dot dot--present" />Present</span>
          <span className="kpi__value">{todayStats.present}</span>
          <span className="kpi__sub">today</span>
        </div>
        <div className="kpi">
          <span className="kpi__label"><span className="dot dot--absent" />Absent</span>
          <span className="kpi__value">{todayStats.absent}</span>
          <span className="kpi__sub">today</span>
        </div>
        <div className="kpi">
          <span className="kpi__label"><span className="dot dot--late" />Late</span>
          <span className="kpi__value">{todayStats.late}</span>
          <span className="kpi__sub">today</span>
        </div>
        <div className="kpi">
          <span className="kpi__label">At-risk students</span>
          <span className="kpi__value">{flagged.length}</span>
          <span className="kpi__sub">{red} high risk</span>
        </div>
      </div>

      <div className="dash-grid">
        <section className="panel panel--pad">
          <div className="panel__head">
            <div>
              <h3 className="panel__title">Daily attendance rate</h3>
              <p className="panel__sub">
                Last {CHART_DAYS} school days
                {termRate != null && ` · 9-week average ${Math.round(termRate * 100)}%`}
              </p>
            </div>
          </div>
          <RateChart days={chartDays} />
        </section>

        <section className="panel panel--pad">
          <div className="panel__head">
            <div>
              <h3 className="panel__title">Absent today</h3>
              <p className="panel__sub">{absentToday.length} student{absentToday.length === 1 ? '' : 's'}</p>
            </div>
          </div>
          {absentToday.length === 0 ? (
            <p className="empty empty--sm">
              {todayStats.marked === 0 ? 'No register taken yet today.' : 'Nobody is absent today.'}
            </p>
          ) : (
            <ul className="mini-list">
              {absentToday.map((s) => (
                <li key={s.studentId}>
                  <button type="button" className="student-cell" onClick={() => onOpenProfile?.(s.studentId)}>
                    <Avatar name={s.fullName} size="sm" />
                    <span className="student-cell__text">
                      <span className="student-cell__name">{s.fullName}</span>
                      <span className="student-cell__sub">{s.admissionNo || '-'}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="panel">
        <div className="panel__head panel__head--pad">
          <div>
            <h3 className="panel__title">Students needing attention</h3>
            <p className="panel__sub">Highest predicted absenteeism risk</p>
          </div>
          <button type="button" className="linkbtn" onClick={onOpenAlerts}>
            View all <ArrowRightIcon size={13} />
          </button>
        </div>
        {flagged.length === 0 ? (
          <p className="empty empty--sm">No students are flagged right now.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Student</th>
                  <th>Risk level</th>
                  <th>Risk score</th>
                  <th className="col-hide-sm">Attendance (last 2 wks)</th>
                </tr>
              </thead>
              <tbody>
                {flagged.slice(0, 5).map(({ student, risk, features }) => {
                  const headline = riskHeadline(risk);
                  return (
                    <tr key={student.studentId} className="row--link" onClick={() => onOpenProfile?.(student.studentId)}>
                      <td>
                        <div className="student-cell student-cell--static">
                          <Avatar name={student.fullName} size="sm" />
                          <span className="student-cell__text">
                            <span className="student-cell__name">{student.fullName}</span>
                            <span className="student-cell__sub">{student.admissionNo || '-'}</span>
                          </span>
                        </div>
                      </td>
                      <td>
                        <span className="risk-level">
                          <span className={`dot dot--${risk.flag === 'red' ? 'absent' : 'late'}`} />
                          {risk.flag === 'red' ? 'High' : 'Medium'}
                        </span>
                      </td>
                      <td><b>{headline.pct}%</b></td>
                      <td className="col-hide-sm">
                        {features.attendance_rate_w1 == null ? '-' : `${Math.round(features.attendance_rate_w1 * 100)}%`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
