import { useEffect, useMemo, useState } from 'react';
import { getStudentById, getStudentHistory } from '../db/database';
import {
  computeFeatures,
  scoreRisk,
  breakdownRows,
  weeklyTrend,
  riskInsights,
  isAssessable,
  isSchoolDay,
  toISO,
} from '../lib/riskModel';
import Avatar from './Avatar';
import { AlertTriangleIcon, ChevronDownIcon } from './icons';

const RISK_LABEL = { red: 'HIGH RISK', amber: 'AT RISK', green: 'ON TRACK' };
const INITIAL_HISTORY = 8;

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

export default function StudentProfile({ studentId, className }) {
  const [student, setStudent] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);

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

  const model = useMemo(() => {
    const asOf = toISO(new Date());
    const rows = history.map((r) => ({ date: r.date, status: r.status }));
    const features = computeFeatures(rows, asOf);
    const risk = scoreRisk(features);
    const trend = weeklyTrend(rows, asOf, 6);
    const insights = riskInsights(rows, features, risk, asOf);

    // crude confidence proxy: more observed school days ⇒ steadier estimate
    const observed = rows.filter((r) => isSchoolDay(r.date)).length;
    const confidence = Math.min(0.95, 0.55 + observed / 200);

    return { features, risk, trend, insights, confidence, assessable: isAssessable(rows) };
  }, [history]);

  if (loading) return <p className="empty">Loading profile…</p>;
  if (!student) return <p className="empty">Student not found.</p>;

  const { risk, trend, insights, confidence, features, assessable } = model;
  const enrolled = student.enrolledAt ? fmtDate(student.enrolledAt).long : '—';
  const recent = [...history].reverse();
  const shown = showAll ? recent : recent.slice(0, INITIAL_HISTORY);

  return (
    <>
      <div className="card">
        <div className="profile-hero">
          <Avatar name={student.fullName} size="lg" />
          <div className="profile-hero__id">
            <div className="profile-hero__name">{student.fullName}</div>
            <div className="profile-hero__meta">
              Class: {className}
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

        {assessable ? (
          <div className={`dropout dropout--${risk.flag}`}>
            <div className="dropout__value">{Math.round(risk.dropoutProbability * 100)}%</div>
            <div className="dropout__label">modelled absenteeism risk</div>
          </div>
        ) : (
          <div className="dropout">
            <div className="dropout__label" style={{ marginTop: 0 }}>
              Not enough recorded attendance yet to assess risk. Keep marking the roll —
              a flag appears after about two weeks of history.
            </div>
          </div>
        )}
      </div>

      {assessable && (
      <div className="card">
        <h2 className="card__title">Risk score breakdown</h2>
        <p className="card__hint">Weighted components of the rule-based score</p>
        <div className="breakdown">
          {breakdownRows(risk.components).map((row) => (
            <div key={row.key} className="breakdown__row">
              <span className="breakdown__name">{row.label}</span>
              <span className="breakdown__num">{row.value.toFixed(2)}</span>
              <span className="breakdown__track">
                <span className="breakdown__fill" style={{ width: `${row.value * 100}%` }} />
              </span>
            </div>
          ))}
        </div>
      </div>
      )}

      <div className="card">
        <h2 className="card__title">6-week trend</h2>
        <p className="card__hint">Weekly attendance rate</p>
        <TrendChart points={trend} />
      </div>

      {assessable && (
      <div className="card">
        <h2 className="card__title">Prediction analysis</h2>
        <p className="card__hint">
          Rule-based scorer · confidence {Math.round(confidence * 100)}%
        </p>
        {insights.map((text, i) => (
          <div key={i} className="insight">
            <span className="insight__icon"><AlertTriangleIcon size={15} /></span>
            <span>{text}</span>
          </div>
        ))}
        {features.attendance_rate_w1 != null && (
          <div className="insight">
            <span className="insight__icon"><AlertTriangleIcon size={15} /></span>
            <span>
              Current 2-week attendance {Math.round(features.attendance_rate_w1 * 100)}%,
              longest absence streak {features.longest_absence_streak} day(s).
            </span>
          </div>
        )}
      </div>
      )}

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
    </>
  );
}
