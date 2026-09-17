import { useEffect, useMemo, useState } from 'react';
import { getStudentsByClass, getClassHistory, getFollowUpSummary } from '../db/database';
import {
  computeFeatures,
  scoreRiskML,
  riskInsights,
  riskHeadline,
  isAssessable,
  toISO,
} from '../lib/riskModel';
import Avatar from './Avatar';
import { AlertTriangleIcon, ArrowRightIcon, PhoneIcon, MailIcon } from './icons';

const HISTORY_DAYS = 63; // 9 weeks — enough for the 6-week trend + 4-week windows

function daysAgoISO(n) {
  const dt = new Date();
  dt.setDate(dt.getDate() - n);
  return toISO(dt);
}

function fmtDaysAgo(iso) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

export default function Alerts({ classGroupId, className, onOpenProfile }) {
  const [students, setStudents] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [followUp, setFollowUp] = useState({ lastAt: new Map(), needsFollowUp: new Set() });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [roll, rows] = await Promise.all([
        getStudentsByClass(classGroupId),
        getClassHistory(classGroupId, daysAgoISO(HISTORY_DAYS)),
      ]);
      if (cancelled) return;
      setStudents(roll);
      setHistory(rows);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [classGroupId]);

  const flagged = useMemo(() => {
    const asOf = toISO(new Date());
    const byStudent = new Map();
    for (const r of history) {
      if (!byStudent.has(r.studentId)) byStudent.set(r.studentId, []);
      byStudent.get(r.studentId).push({ date: r.date, status: r.status });
    }
    return students
      .map((student) => {
        const rows = byStudent.get(student.studentId) ?? [];
        const features = computeFeatures(rows, asOf);
        const risk = scoreRiskML(rows, asOf);
        return { student, features, risk, rows, assessable: isAssessable(rows) };
      })
      .filter((r) => r.assessable && r.risk.flag !== 'green')
      .sort((a, b) => b.risk.score - a.risk.score);
  }, [students, history]);

  useEffect(() => {
    let cancelled = false;
    getFollowUpSummary(flagged.map((f) => f.student.studentId)).then((summary) => {
      if (!cancelled) setFollowUp(summary);
    });
    return () => { cancelled = true; };
  }, [flagged]);

  if (loading) return <p className="empty">Assessing attendance risk…</p>;

  return (
    <>
      <div className="alerts-banner">
        <span className="alerts-banner__title">Risk Alerts</span>
        <span className="alerts-banner__flag">
          <AlertTriangleIcon size={15} />
          {flagged.length} flagged
        </span>
      </div>

      {flagged.length === 0 ? (
        <p className="empty">No students flagged this month.</p>
      ) : (
        flagged.map(({ student, features, risk, rows }) => {
          const headline = riskHeadline(risk);
          const insight = riskInsights(rows, features, risk)[0];
          return (
            <article key={student.studentId} className={`alert-card alert-card--${risk.flag}`}>
              <div className="alert-card__head">
                <Avatar name={student.fullName} size="md" />
                <div className="alert-card__id">
                  <div className="alert-card__name">{student.fullName}</div>
                  <div className="alert-card__meta">{className} · ID {student.admissionNo}</div>
                </div>
                <span className={`pill pill--risk-${risk.flag === 'red' ? 'red' : 'amber'}`}>
                  {risk.flag === 'red' ? 'RED' : 'AMBER'}
                </span>
              </div>

              <p className="alert-card__body">{insight}</p>

              {(student.guardianPhone || student.guardianEmail) && (
                <div className="alert-card__contact">
                  {student.guardianPhone && (
                    <a href={`tel:${student.guardianPhone}`}><PhoneIcon size={14} /> {student.guardianPhone}</a>
                  )}
                  {student.guardianEmail && (
                    <a href={`mailto:${student.guardianEmail}`}><MailIcon size={14} /> {student.guardianEmail}</a>
                  )}
                </div>
              )}

              <div className="alert-card__foot">
                <span className="alert-card__risk">
                  {headline.label}: <b>{headline.pct}%</b>
                  {followUp.lastAt.has(student.studentId) ? (
                    <span className="followup-badge followup-badge--done">
                      · followed up {fmtDaysAgo(followUp.lastAt.get(student.studentId))}
                    </span>
                  ) : (
                    <span className="followup-badge followup-badge--needed"> · not yet followed up</span>
                  )}
                </span>
                <button
                  type="button"
                  className={`btn btn--sm${risk.flag === 'red' ? '' : ' btn--ghost'}`}
                  onClick={() => onOpenProfile?.(student.studentId)}
                >
                  Follow up
                  <ArrowRightIcon size={15} />
                </button>
              </div>
            </article>
          );
        })
      )}

      <p className="card__hint" style={{ textAlign: 'center', marginTop: 16 }}>
        Flags use the ML risk model.
      </p>
    </>
  );
}
