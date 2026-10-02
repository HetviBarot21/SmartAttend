import { useState } from 'react';
import { riskInsights, riskHeadline } from '../lib/riskModel';
import { useClassRisk } from '../hooks/useClassRisk';
import Avatar from './Avatar';
import { ChevronRightIcon, PhoneIcon } from './icons';

const RISK_TEXT = { red: 'High', amber: 'Medium' };

function fmtDaysAgo(iso) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

export default function Alerts({ classGroupId, className, onOpenProfile }) {
  const { loading, students, flagged, followUp } = useClassRisk(classGroupId);
  const [level, setLevel] = useState('all');

  if (loading) return <p className="empty">Assessing attendance risk…</p>;

  const red = flagged.filter((f) => f.risk.flag === 'red').length;
  const amber = flagged.length - red;
  const pending = flagged.filter((f) => !followUp.lastAt.has(f.student.studentId)).length;
  const shown = level === 'all' ? flagged : flagged.filter((f) => f.risk.flag === level);

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">At-risk students</h2>
          <p className="page-head__sub">
            {className} · students the ML model predicts may become persistently absent
          </p>
        </div>
      </div>

      <div className="kpis kpis--4">
        <div className="kpi">
          <span className="kpi__label">Students assessed</span>
          <span className="kpi__value">{students.length}</span>
        </div>
        <div className="kpi">
          <span className="kpi__label"><span className="dot dot--absent" />High risk</span>
          <span className="kpi__value">{red}</span>
        </div>
        <div className="kpi">
          <span className="kpi__label"><span className="dot dot--late" />Medium risk</span>
          <span className="kpi__value">{amber}</span>
        </div>
        <div className="kpi">
          <span className="kpi__label">Awaiting follow-up</span>
          <span className="kpi__value">{pending}</span>
        </div>
      </div>

      <div className="panel">
        <div className="panel__toolbar">
          <div className="chips" role="tablist" aria-label="Filter by risk level">
            {[
              { id: 'all', label: 'All flagged', n: flagged.length },
              { id: 'red', label: 'High risk', n: red },
              { id: 'amber', label: 'Medium risk', n: amber },
            ].map((c) => (
              <button
                key={c.id}
                type="button"
                role="tab"
                aria-selected={level === c.id}
                className="chip"
                onClick={() => setLevel(c.id)}
              >
                {c.label}
                <span className="chip__count">{c.n}</span>
              </button>
            ))}
          </div>
        </div>

        {shown.length === 0 ? (
          <p className="empty">No students flagged. Everyone in this class is on track.</p>
        ) : (
          <div className="table-wrap">
            <table className="table table--stack risk-table">
              <thead>
                <tr>
                  <th>Student</th>
                  <th>Risk level</th>
                  <th>Risk score</th>
                  <th>Why flagged</th>
                  <th>Follow-up</th>
                  <th aria-hidden="true" />
                </tr>
              </thead>
              <tbody>
                {shown.map(({ student, features, risk, rows }) => {
                  const headline = riskHeadline(risk);
                  const insight = riskInsights(rows, features, risk)[0];
                  const last = followUp.lastAt.get(student.studentId);
                  return (
                    <tr
                      key={student.studentId}
                      className="row--link"
                      tabIndex={0}
                      onClick={() => onOpenProfile?.(student.studentId)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onOpenProfile?.(student.studentId);
                        }
                      }}
                      aria-label={`Open ${student.fullName}`}
                    >
                      <td data-label="Student">
                        <div className="student-cell student-cell--static">
                          <Avatar name={student.fullName} size="sm" />
                          <span className="student-cell__text">
                            <span className="student-cell__name">{student.fullName}</span>
                            <span className="student-cell__sub">
                              {student.admissionNo || '-'}
                              {student.guardianPhone && (
                                <a className="inline-link" href={`tel:${student.guardianPhone}`} onClick={(e) => e.stopPropagation()}>
                                  <PhoneIcon size={12} /> {student.guardianPhone}
                                </a>
                              )}
                            </span>
                          </span>
                        </div>
                      </td>
                      <td data-label="Risk level">
                        <span className="risk-level">
                          <span className={`dot dot--${risk.flag === 'red' ? 'absent' : 'late'}`} />
                          {RISK_TEXT[risk.flag]}
                        </span>
                      </td>
                      <td data-label="Risk score">
                        <div className="meter">
                          <span className="meter__value">{headline.pct}%</span>
                          <span className="meter__track">
                            <span className={`meter__fill meter__fill--${risk.flag}`} style={{ width: `${headline.pct}%` }} />
                          </span>
                        </div>
                      </td>
                      <td data-label="Why flagged" className="cell-wrap">{insight}</td>
                      <td data-label="Follow-up">
                        {last ? (
                          <span className="followup followup--done">Done {fmtDaysAgo(last)}</span>
                        ) : (
                          <span className="followup">Not yet</span>
                        )}
                      </td>
                      <td className="cell-chevron" aria-hidden="true">
                        <ChevronRightIcon size={16} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="footnote">
        Click a student to see their attendance history and log a follow-up. Risk is predicted by the trained ML model from each student&apos;s recent attendance. Students need at least
        8 recorded school days before they are assessed.
      </p>
    </>
  );
}
