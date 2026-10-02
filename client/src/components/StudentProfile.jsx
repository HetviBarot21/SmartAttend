import { useEffect, useMemo, useState } from 'react';
import { getStudentById, getStudentHistory, getFollowUpSummary } from '../db/database';
import {
  computeFeatures,
  scoreRiskML,
  weeklyTrend,
  riskInsights,
  isAssessable,
  toISO,
} from '../lib/riskModel';
import Avatar from './Avatar';
import FollowUpPanel from './FollowUpPanel';
import { ChevronLeftIcon, ChevronRightIcon } from './icons';

const RISK_LABEL = { red: 'High risk', amber: 'Medium risk', green: 'On track' };
const RISK_TAKEAWAY = {
  red: 'Likely to keep missing school without a check-in.',
  amber: 'Attendance has slipped. Worth a check-in soon.',
};

function trendLabel(trend) {
  if (trend == null) return null;
  if (trend <= -0.1) return 'Getting worse';
  if (trend >= 0.1) return 'Improving';
  return 'Steady';
}

function fmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return {
    long: dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
    weekday: dt.toLocaleDateString('en-GB', { weekday: 'long' }),
  };
}

function TrendChart({ points }) {
  const w = 440;
  const h = 120;
  const pad = 32;
  const min = 0;
  const max = 1;
  const x = (i) => pad + (i * (w - pad * 2)) / Math.max(1, points.length - 1);
  const y = (v) => h - pad - ((v - min) / (max - min || 1)) * (h - pad * 2);

  const line = points
    .map((p, i) => (p.rate == null ? null : `${x(i)},${y(p.rate)}`))
    .filter(Boolean)
    .join(' ');

  return (
    <svg className="trend-chart" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Six week attendance trend">
      {[0, 0.5, 1].map((v) => (
        <g key={v}>
          <line x1={pad} y1={y(v)} x2={w - pad / 2} y2={y(v)} stroke="var(--line)" strokeWidth="1" strokeDasharray={v ? '3 3' : undefined} />
          <text className="trend-axis" x={pad - 4} y={y(v) + 3} textAnchor="end">{v * 100}%</text>
        </g>
      ))}
      {line && <polyline points={line} fill="none" stroke="var(--slate-700)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />}
      {points.map((p, i) =>
        p.rate == null ? null : (
          <circle key={p.label} cx={x(i)} cy={y(p.rate)} r="3.5" fill="var(--slate-700)" />
        )
      )}
      {points.map((p, i) => (
        <text key={`t-${p.label}`} className="trend-axis" x={x(i)} y={h - 6} textAnchor="middle">
          {p.label}
        </text>
      ))}
    </svg>
  );
}

const CAL_CODE = { present: 'P', late: 'L', absent: 'A' };
const CAL_TEXT = { present: 'Present', late: 'Late', absent: 'Absent' };

function addMonths(iso, n) {
  const [y, m] = iso.split('-').map(Number);
  return toISO(new Date(y, m - 1 + n, 1));
}

/** Month calendar of school days (Mon-Fri) with the student's status on each. */
function AttendanceCalendar({ history }) {
  const today = toISO(new Date());
  const [month, setMonth] = useState(() => `${today.slice(0, 7)}-01`);
  const byDate = useMemo(() => new Map(history.map((r) => [r.date, r.status])), [history]);
  const first = history.length ? history[0].date.slice(0, 7) : today.slice(0, 7);

  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const weeks = [];
  let week = null;
  for (let d = 1; d <= daysInMonth; d += 1) {
    const dt = new Date(y, m - 1, d);
    const dow = dt.getDay();
    if (dow === 0 || dow === 6) continue;
    if (!week || dow === 1) {
      week = Array(5).fill(null);
      weeks.push(week);
    }
    week[dow - 1] = toISO(dt);
  }

  const monthCounts = { present: 0, late: 0, absent: 0 };
  for (const w of weeks) for (const iso of w) if (iso && byDate.has(iso)) monthCounts[byDate.get(iso)] += 1;
  const label = new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  return (
    <div className="att-cal">
      <div className="panel__head">
        <div>
          <h3 className="panel__title">Attendance calendar</h3>
          <p className="panel__sub">
            {monthCounts.present} present · {monthCounts.late} late · {monthCounts.absent} absent this month
          </p>
        </div>
        <div className="period-nav">
          <button
            type="button"
            className="icon-btn"
            onClick={() => setMonth((v) => addMonths(v, -1))}
            disabled={month.slice(0, 7) <= first}
            aria-label="Previous month"
          >
            <ChevronLeftIcon size={16} />
          </button>
          <span className="period-nav__label">{label}</span>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setMonth((v) => addMonths(v, 1))}
            disabled={month.slice(0, 7) >= today.slice(0, 7)}
            aria-label="Next month"
          >
            <ChevronRightIcon size={16} />
          </button>
        </div>
      </div>

      <table className="att-cal__grid">
        <thead>
          <tr>{['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((d) => <th key={d}>{d}</th>)}</tr>
        </thead>
        <tbody>
          {weeks.map((w, i) => (
            <tr key={i}>
              {w.map((iso, j) => {
                if (!iso) return <td key={j} />;
                const status = byDate.get(iso);
                const future = iso > today;
                return (
                  <td key={j} className={`${iso === today ? 'is-today' : ''}${future ? ' is-future' : ''}`}>
                    <span className="att-cal__day">{Number(iso.slice(8, 10))}</span>
                    <span
                      className={`reg-code reg-code--${status ?? 'upcoming'}`}
                      title={status ? CAL_TEXT[status] : future ? 'Upcoming' : 'No record'}
                    >
                      {status ? CAL_CODE[status] : '-'}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProfilePage({ children }) {
  return <div className="profile-page">{children}</div>;
}

export default function StudentProfile({ studentId, className }) {
  const [student, setStudent] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [followUp, setFollowUp] = useState({ lastAt: new Map() });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [s, h] = await Promise.all([getStudentById(studentId), getStudentHistory(studentId)]);
      if (cancelled) return;
      setStudent(s);
      setHistory(h);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [studentId]);

  useEffect(() => {
    let cancelled = false;
    getFollowUpSummary([studentId]).then((summary) => { if (!cancelled) setFollowUp(summary); });
    return () => { cancelled = true; };
  }, [studentId]);

  const model = useMemo(() => {
    const asOf = toISO(new Date());
    const rows = history.map((r) => ({ date: r.date, status: r.status }));
    const features = computeFeatures(rows, asOf);
    const risk = scoreRiskML(rows, asOf);
    const trend = weeklyTrend(rows, asOf, 6);
    const insights = riskInsights(rows, features, risk, asOf);

    return { features, risk, trend, insights, assessable: isAssessable(rows) };
  }, [history]);

  if (loading) return <ProfilePage><p className="empty">Loading profile…</p></ProfilePage>;
  if (!student) return <ProfilePage><p className="empty">Student not found.</p></ProfilePage>;

  const { risk, trend, insights, features, assessable } = model;
  const enrolled = student.enrolledAt ? fmtDate(student.enrolledAt).long : '-';
  const counts = { present: 0, late: 0, absent: 0 };
  for (const r of history) if (r.status in counts) counts[r.status] += 1;
  const recorded = counts.present + counts.late + counts.absent;
  const overallRate = recorded ? (counts.present + counts.late) / recorded : null;
  const flagged = assessable && risk.flag !== 'green';
  const lastFollowUp = followUp.lastAt.get(studentId);

  return (
    <ProfilePage>
      <section className="panel panel--pad profile-head">
        <Avatar name={student.fullName} size="lg" />
        <div className="profile-head__id">
          <h2 className="profile-head__name">{student.fullName}</h2>
          <p className="profile-head__meta">
            <span>Adm. No. <b>{student.admissionNo || '-'}</b></span>
            <span>Class <b>{className}</b></span>
            <span>Card <b>{student.cardUid || 'not issued'}</b></span>
            <span>Enrolled <b>{enrolled}</b></span>
          </p>
        </div>
        <div className="profile-head__status">
          {assessable ? (
            <span className={`risk-tag risk-tag--${risk.flag}`}>
              <span className={`dot dot--${risk.flag === 'red' ? 'absent' : risk.flag === 'amber' ? 'late' : 'present'}`} />
              {RISK_LABEL[risk.flag]}
            </span>
          ) : (
            <span className="risk-tag">Not yet assessed</span>
          )}
          {flagged && (
            <span className="profile-head__followup">
              {lastFollowUp
                ? `Followed up ${new Date(lastFollowUp).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
                : 'Not yet followed up'}
            </span>
          )}
        </div>
      </section>

      <div className="stat-strip stat-strip--6">
        <div>
          <span className="stat-strip__label">Attendance (all records)</span>
          <span className="stat-strip__value">{overallRate == null ? '-' : `${Math.round(overallRate * 100)}%`}</span>
        </div>
        <div>
          <span className="stat-strip__label">Last 2 weeks</span>
          <span className="stat-strip__value">
            {features.attendance_rate_w1 == null ? '-' : `${Math.round(features.attendance_rate_w1 * 100)}%`}
          </span>
        </div>
        <div>
          <span className="stat-strip__label">Days present</span>
          <span className="stat-strip__value">{counts.present}</span>
        </div>
        <div>
          <span className="stat-strip__label">Days late</span>
          <span className="stat-strip__value">{counts.late}</span>
        </div>
        <div>
          <span className="stat-strip__label">Days absent</span>
          <span className="stat-strip__value">{counts.absent}</span>
        </div>
        <div>
          <span className="stat-strip__label">Trend</span>
          <span className="stat-strip__value">{trendLabel(features.attendance_trend) ?? '-'}</span>
        </div>
      </div>

      <div className="profile-grid">
        <div className="profile-grid__main">
          <section className="panel panel--pad">
            <AttendanceCalendar history={history} />
          </section>

          <section className="panel panel--pad">
            <div className="panel__head">
              <div>
                <h3 className="panel__title">Weekly attendance</h3>
                <p className="panel__sub">Share of school days attended, last 6 weeks</p>
              </div>
            </div>
            <TrendChart points={trend} />
          </section>
        </div>

        <aside className="profile-grid__side">
          <section className="panel panel--pad">
            <h3 className="panel__title">Absenteeism risk</h3>
            {assessable ? (
              <>
                <div className="risk-score">
                  <span className="risk-score__value">{Math.round(risk.dropoutProbability * 100)}%</span>
                  <span className="risk-score__label">predicted chance of continued absence</span>
                </div>
                <div className="meter__track risk-score__track">
                  <span
                    className={`meter__fill meter__fill--${risk.flag === 'red' ? 'red' : 'amber'}`}
                    style={{ width: `${Math.round(risk.dropoutProbability * 100)}%` }}
                  />
                </div>
                {RISK_TAKEAWAY[risk.flag] && <p className="risk-score__takeaway">{RISK_TAKEAWAY[risk.flag]}</p>}
                {flagged && insights.length > 0 && (
                  <>
                    <h4 className="panel__subtitle">Why flagged</h4>
                    <ul className="reason-list">
                      {insights.map((text, i) => (
                        <li key={i} className={`reason-list__item reason-list__item--${risk.flag}`}>{text}</li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            ) : (
              <p className="panel__sub" style={{ marginTop: 8 }}>
                Not enough attendance yet to assess risk. A prediction appears after about two weeks of records.
              </p>
            )}
          </section>

          {flagged && (
            <FollowUpPanel
              studentId={studentId}
              flag={risk.flag}
              student={student}
              onStudentUpdated={(updated) => setStudent((s) => ({ ...s, ...updated }))}
            />
          )}
        </aside>
      </div>
    </ProfilePage>
  );
}
