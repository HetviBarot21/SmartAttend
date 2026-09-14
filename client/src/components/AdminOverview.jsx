import { useCallback, useEffect, useState } from 'react';
import { getSchoolOverview, getSchoolClasses, getSchoolFlagged } from '../services/adminService';
import { useAuth } from '../auth/AuthContext';
import Avatar from './Avatar';
import { ArrowRightIcon, PhoneIcon, MailIcon } from './icons';

const RISK_LABEL = { red: 'RED', amber: 'AMBER' };
const METHOD_LABEL = {
  parent_call: 'Called parent/guardian', sms: 'Sent SMS', home_visit: 'Home visit', meeting: 'Met at school', other: 'Other',
};

/**
 * The central-admin landing screen: every class in the school, who teaches
 * it, and every flagged student school-wide with a "log a follow-up" action -
 * the cross-class counterpart of a single teacher's Alerts tab. Reads live
 * from server/src/routes/admin.js (services/adminService.js), not Dexie -
 * this is deliberately "what has every teacher's device pushed to the
 * server," not this device's own local data.
 */
export default function AdminOverview({ onOpenClass }) {
  const { user } = useAuth();
  const schoolId = user?.schoolId;

  const [overview, setOverview] = useState(null);
  const [classes, setClasses] = useState([]);
  const [flagged, setFlagged] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [logging, setLogging] = useState(null);
  const [method, setMethod] = useState('parent_call');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!schoolId) return;
    setLoading(true);
    setError(null);
    try {
      const [ov, cls, fl] = await Promise.all([
        getSchoolOverview(schoolId),
        getSchoolClasses(schoolId),
        getSchoolFlagged(schoolId),
      ]);
      setOverview(ov);
      setClasses(cls);
      setFlagged(fl);
    } catch (err) {
      setError(err.message ?? 'Could not reach the server');
    } finally {
      setLoading(false);
    }
  }, [schoolId]);

  useEffect(() => { load(); }, [load]);

  async function submitFollowUp(studentId, flag) {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/students/${studentId}/follow-ups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flag, method, note: note.trim() || null, actor: user?.username ?? null }),
      });
      if (!res.ok) throw new Error(`server responded ${res.status}`);
      setLogging(null);
      setNote('');
      await load();
    } catch (err) {
      setError(err.message ?? 'Could not log the follow-up');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="empty">Loading school overview…</p>;
  if (error) {
    return (
      <p className="empty">Could not reach the server ({error}). Check it's running and you're online.</p>
    );
  }
  if (!overview) return null;

  return (
    <>
      <div className="admin-stats">
        <div className="stat-card">
          <div className="stat-card__value">{overview.classCount}</div>
          <div className="stat-card__label">Classes</div>
        </div>
        <div className="stat-card">
          <div className="stat-card__value">{overview.studentCount}</div>
          <div className="stat-card__label">Students</div>
        </div>
        <div className="stat-card">
          <div className="stat-card__value">
            {overview.attendanceRateToday != null ? `${Math.round(overview.attendanceRateToday * 100)}%` : '—'}
          </div>
          <div className="stat-card__label">Attendance today</div>
        </div>
        <div className="stat-card stat-card--risk">
          <div className="stat-card__value">{overview.flaggedCount}</div>
          <div className="stat-card__label">Flagged</div>
        </div>
        <div className="stat-card stat-card--risk">
          <div className="stat-card__value">{overview.needsFollowUpCount}</div>
          <div className="stat-card__label">Needs follow-up</div>
        </div>
      </div>

      <h2 className="section-heading">Classes</h2>
      <div className="admin-table">
        {classes.map((c) => (
          <button
            key={c.classGroupId}
            type="button"
            className="admin-table__row"
            onClick={() => onOpenClass(c.classGroupId)}
          >
            <span className="admin-table__name">{[c.grade, c.stream].filter(Boolean).join(' ') || c.classGroupId}</span>
            <span className="admin-table__meta">{c.teacherName || 'No teacher on record'}</span>
            <span className="admin-table__meta">{c.studentCount} student{c.studentCount === 1 ? '' : 's'}</span>
            <ArrowRightIcon size={15} />
          </button>
        ))}
        {classes.length === 0 && <p className="empty">No classes have reached the server yet.</p>}
      </div>

      <h2 className="section-heading">School-wide flagged students</h2>
      {flagged.length === 0 ? (
        <p className="empty">No students are flagged for attendance risk right now.</p>
      ) : (
        <div className="admin-grid">
          {flagged.map((f) => (
            <article key={f.studentId} className={`alert-card alert-card--${f.flag}`}>
              <div className="alert-card__head">
                <Avatar name={f.fullName} size="md" />
                <div className="alert-card__id">
                  <div className="alert-card__name">{f.fullName}</div>
                  <div className="alert-card__meta">{f.className} · {f.teacherName || 'unassigned'}</div>
                </div>
                <span className={`pill pill--risk-${f.flag === 'red' ? 'red' : 'amber'}`}>{RISK_LABEL[f.flag]}</span>
              </div>

              {(f.guardianPhone || f.guardianEmail) && (
                <div className="alert-card__contact">
                  {f.guardianPhone && <a href={`tel:${f.guardianPhone}`}><PhoneIcon size={14} /> {f.guardianPhone}</a>}
                  {f.guardianEmail && <a href={`mailto:${f.guardianEmail}`}><MailIcon size={14} /> {f.guardianEmail}</a>}
                </div>
              )}

              <div className="alert-card__foot">
                <span className="alert-card__risk">
                  Absenteeism risk: <b>{Math.round(f.dropoutProbability * 100)}%</b>
                  <span className={`followup-badge followup-badge--${f.needsFollowUp ? 'needed' : 'done'}`}>
                    {f.needsFollowUp ? ' · not yet followed up' : ' · followed up'}
                  </span>
                </span>
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={() => setLogging(logging === f.studentId ? null : f.studentId)}
                >
                  Log follow-up
                </button>
              </div>

              {logging === f.studentId && (
                <div className="followup-form" style={{ marginTop: 10 }}>
                  <select className="field__input" value={method} onChange={(e) => setMethod(e.target.value)} disabled={busy}>
                    {Object.entries(METHOD_LABEL).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                  <input
                    className="field__input" style={{ marginTop: 8 }} type="text"
                    placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} disabled={busy}
                  />
                  <button
                    type="button" className="btn btn--sm" style={{ marginTop: 8 }}
                    onClick={() => submitFollowUp(f.studentId, f.flag)} disabled={busy}
                  >
                    {busy ? 'Saving…' : 'Save'}
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </>
  );
}
