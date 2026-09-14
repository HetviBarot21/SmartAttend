import { useEffect, useMemo, useState } from 'react';
import { getStudentById, getStudentHistory, getFollowUpSummary } from '../db/database';
import {
  computeFeatures,
  scoreRisk,
  weeklyTrend,
  riskInsights,
  isAssessable,
  toISO,
} from '../lib/riskModel';
import Avatar from './Avatar';
import TopBar from './TopBar';
import FollowUpPanel from './FollowUpPanel';
import { AlertTriangleIcon, ChevronDownIcon } from './icons';

const RISK_LABEL = { red: 'HIGH RISK', amber: 'AT RISK', green: 'ON TRACK' };
const RISK_TAKEAWAY = {
  red: 'Likely to keep missing school without a check-in.',
  amber: 'Attendance has slipped. Worth a check-in soon.',
};
const INITIAL_HISTORY = 8;

/** Plain-language read on the attendance_trend feature (rate_w1 - rate_w2). */
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

/** Tiny inline line chart for the 6-week trend. */
function TrendChart({ points }) {
  const w = 300;
  const h = 120;
  const pad = 24;
  const vals = points.map((p) => p.rate);
  const known = vals.filter((v) => v != null);
  const min = known.length ? Math.min(...known, 0.5) : 0;
  const max = 1;
  const x = (i) => pad + (i * (w - pad * 2)) / Math.max(1, points.length - 1);
  const y = (v) => h - pad - ((v - min) / (max - min || 1)) * (h - pad * 2);

  const line = points
    .map((p, i) => (p.rate == null ? null : `${x(i)},${y(p.rate)}`))
    .filter(Boolean)
    .join(' ');

  return (
    <svg className="trend-chart" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Six week attendance trend">
      <line x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} stroke="var(--line)" strokeWidth="1" />
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

/** Full-screen page shell so the profile is a proper page, not an inline panel. */
function ProfilePage({ title, onBack, children }) {
  return (
    <div className="app">
      <TopBar title={title} onBack={onBack} />
      <div className="app__scroll">{children}</div>
    </div>
  );
}

export default function StudentProfile({ studentId, className, onBack }) {
  const [student, setStudent] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);
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
    const risk = scoreRisk(features);
    const trend = weeklyTrend(rows, asOf, 6);
    const insights = riskInsights(rows, features, risk, asOf);

    return { features, risk, trend, insights, assessable: isAssessable(rows) };
  }, [history]);

  if (loading) return <ProfilePage title="Profile" onBack={onBack}><p className="empty">Loading profile…</p></ProfilePage>;
  if (!student) return <ProfilePage title="Profile" onBack={onBack}><p className="empty">Student not found.</p></ProfilePage>;

  const { risk, trend, insights, features, assessable } = model;
  const enrolled = student.enrolledAt ? fmtDate(student.enrolledAt).long : '—';
  const recent = [...history].reverse();
  const shown = showAll ? recent : recent.slice(0, INITIAL_HISTORY);

  return (
    <ProfilePage title={student.fullName} onBack={onBack}>
      <div className="card">
        <div className="profile-hero">
          <Avatar name={student.fullName} size="lg" />
          <div className="profile-hero__id">
            <div className="profile-hero__name">{student.fullName}</div>
            <div className="profile-hero__meta">
              Class: {className}
              <br />Admission no: {student.admissionNo || '—'}
              <br />RFID card: {student.cardUid || 'not issued'}
              <br />Enrolled: {enrolled}
            </div>
          </div>
          {assessable ? (
            <span className={`pill pill--risk-${risk.flag === 'red' ? 'red' : 'amber'}`}>
              {RISK_LABEL[risk.flag]}
            </span>
          ) : (
            <span className="pill pill--unmarked">NEW</span>
          )}
        </div>

        {assessable && risk.flag !== 'green' && (
          <div className={`followup-badge followup-badge--${followUp.lastAt.has(studentId) ? 'done' : 'needed'}`} style={{ marginTop: 10 }}>
            {followUp.lastAt.has(studentId)
              ? `Followed up ${new Date(followUp.lastAt.get(studentId)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
              : 'Not yet followed up'}
          </div>
        )}

        {assessable ? (
          <div className={`dropout dropout--${risk.flag}`}>
            <div className="dropout__value">{Math.round(risk.dropoutProbability * 100)}%</div>
            <div className="dropout__label">risk of continued absence</div>
            {RISK_TAKEAWAY[risk.flag] && <div className="dropout__takeaway">{RISK_TAKEAWAY[risk.flag]}</div>}
          </div>
        ) : (
          <div className="dropout">
            <div className="dropout__label" style={{ marginTop: 0 }}>
              Not enough attendance yet to assess risk. A flag appears after about two weeks.
            </div>
          </div>
        )}
      </div>

      {assessable && risk.flag !== 'green' && (
        <FollowUpPanel
          studentId={studentId}
          flag={risk.flag}
          student={student}
          onStudentUpdated={(updated) => setStudent((s) => ({ ...s, ...updated }))}
        />
      )}

      {assessable && (
      <div className="card">
        <h2 className="card__title">Why this student is flagged</h2>

        <div className="fact-row">
          {features.attendance_rate_w1 != null && (
            <div className="fact-chip">
              <span className="fact-chip__value">{Math.round(features.attendance_rate_w1 * 100)}%</span>
              <span className="fact-chip__label">present, last 2 weeks</span>
            </div>
          )}
          <div className="fact-chip">
            <span className="fact-chip__value">{features.longest_absence_streak}</span>
            <span className="fact-chip__label">day{features.longest_absence_streak === 1 ? '' : 's'} away in a row</span>
          </div>
          {trendLabel(features.attendance_trend) && (
            <div className="fact-chip">
              <span className="fact-chip__value">{trendLabel(features.attendance_trend)}</span>
              <span className="fact-chip__label">trend</span>
            </div>
          )}
        </div>

        {insights.map((text, i) => (
          <div key={i} className="insight">
            <span className="insight__icon"><AlertTriangleIcon size={15} /></span>
            <span>{text}</span>
          </div>
        ))}
      </div>
      )}

      <div className="card">
        <h2 className="card__title">6-week trend</h2>
        <p className="card__hint">Weekly attendance rate</p>
        <TrendChart points={trend} />
      </div>

      <div className="card">
        <h2 className="card__title">Attendance history</h2>
        {recent.length === 0 ? (
          <p className="empty" style={{ padding: '12px 0' }}>No records yet.</p>
        ) : (
          <>
            {shown.map((r) => {
              const d = fmtDate(r.date);
              return (
                <div key={r.eventId ?? r.date} className="history-row">
                  <span className="history-row__date">
                    <b>{d.long}</b>
                    <span>{d.weekday}</span>
                  </span>
                  <span className={`pill pill--${r.status}`}>{r.status}</span>
                </div>
              );
            })}
            {recent.length > INITIAL_HISTORY && (
              <button
                type="button"
                className="linkbtn"
                style={{ display: 'flex', alignItems: 'center', gap: 4, margin: '10px auto 0' }}
                onClick={() => setShowAll((v) => !v)}
              >
                {showAll ? 'Show fewer' : 'View older records'}
                <ChevronDownIcon size={14} />
              </button>
            )}
          </>
        )}
      </div>
    </ProfilePage>
  );
}
