import { useCallback, useEffect, useState } from 'react';
import {
  getStudentsByClass,
  addStudent,
  updateStudent,
  removeStudent,
} from '../db/database';
import Avatar from './Avatar';
import TopBar from './TopBar';

/**
 * Class roster editor - the initial-setup step and ongoing add/remove of
 * students. Reached from the account sheet. All changes are local to this
 * device; the roster does not yet sync to Tier 2 (see PROJECT_CONTEXT).
 */
export default function RosterManager({ classGroupId, className, onClose }) {
  const [active, setActive] = useState([]);
  const [removed, setRemoved] = useState([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [admissionNo, setAdmissionNo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirmId, setConfirmId] = useState(null);

  const load = useCallback(async () => {
    const all = await getStudentsByClass(classGroupId, { includeInactive: true });
    setActive(all.filter((s) => s.active !== false));
    setRemoved(all.filter((s) => s.active === false));
    setLoading(false);
  }, [classGroupId]);

  useEffect(() => { load(); }, [load]);

  async function handleAdd(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await addStudent({ classGroupId, fullName: name, admissionNo });
      setName('');
      setAdmissionNo('');
      await load();
    } catch (err) {
      setError(err.message ?? 'Could not add the student');
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(studentId) {
    setBusy(true);
    setConfirmId(null);
    try {
      await removeStudent(studentId);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function handleRestore(studentId) {
    setBusy(true);
    try {
      await updateStudent(studentId, { active: true });
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <TopBar title="Class Roster" onBack={onClose} />

      <div className="app__scroll">
        <p className="card__hint" style={{ marginTop: 4 }}>
          {className} · {active.length} student{active.length === 1 ? '' : 's'}
        </p>

        <form className="card" onSubmit={handleAdd}>
          <h2 className="card__title">Add a student</h2>
          <p className="card__hint">They appear on today’s roll call straight away.</p>

          {error && <div className="notice notice--err" role="alert">{error}</div>}

          <div className="field">
            <label className="field__label" htmlFor="rm-name">Full name</label>
            <input
              id="rm-name"
              className="field__input"
              type="text"
              autoComplete="off"
              placeholder="e.g. Amina Wanjiru"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              required
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="rm-adm">Admission number <span style={{ fontWeight: 400 }}>(optional)</span></label>
            <input
              id="rm-adm"
              className="field__input"
              type="text"
              autoComplete="off"
              placeholder="e.g. 3B/011"
              value={admissionNo}
              onChange={(e) => setAdmissionNo(e.target.value)}
              disabled={busy}
            />
          </div>

          <button className="btn" type="submit" disabled={busy || name.trim() === ''}>
            {busy ? 'Working…' : 'Add student'}
          </button>
        </form>

        {loading ? (
          <p className="empty">Loading roster…</p>
        ) : active.length === 0 ? (
          <p className="empty">No students yet. Add the first one above.</p>
        ) : (
          <div className="roll">
            {active.map((s) => (
              <div key={s.studentId} className="roll-row">
                <Avatar name={s.fullName} size="sm" />
                <div className="roll-row__who" style={{ cursor: 'default' }}>
                  <span className="roll-row__name">{s.fullName}</span>
                  <span className="roll-row__id">ID: {s.admissionNo || '—'}</span>
                </div>
                {confirmId === s.studentId ? (
                  <span className="roster-confirm">
                    <button type="button" className="linkbtn" onClick={() => handleRemove(s.studentId)} disabled={busy}>
                      Remove
                    </button>
                    <button type="button" className="linkbtn linkbtn--muted" onClick={() => setConfirmId(null)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="roster-x"
                    aria-label={`Remove ${s.fullName}`}
                    onClick={() => setConfirmId(s.studentId)}
                    disabled={busy}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {removed.length > 0 && (
          <>
            <p className="section-label">Removed</p>
            <div className="roll">
              {removed.map((s) => (
                <div key={s.studentId} className="roll-row" style={{ opacity: 0.7 }}>
                  <Avatar name={s.fullName} size="sm" />
                  <div className="roll-row__who" style={{ cursor: 'default' }}>
                    <span className="roll-row__name">{s.fullName}</span>
                    <span className="roll-row__id">history kept</span>
                  </div>
                  <button type="button" className="linkbtn" onClick={() => handleRestore(s.studentId)} disabled={busy}>
                    Restore
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        <div aria-hidden="true" style={{ height: 24 }} />
        <button type="button" className="btn btn--ghost" onClick={onClose}>Done</button>
        <div aria-hidden="true" style={{ height: 24 }} />
      </div>
    </div>
  );
}
