import { useCallback, useEffect, useState } from 'react';
import {
  getStudentsByClass,
  addStudent,
  updateStudent,
  removeStudent,
  issueCard,
} from '../db/database';
import Avatar from './Avatar';
import TopBar from './TopBar';
import CardList from './CardList';

/**
 * Class roster editor - enrol / remove students and reissue lost RFID cards.
 * Every enrolled student is issued a card number automatically; "Print cards"
 * opens a printable list to encode onto the physical cards.
 * Reached from the account sheet or the class switcher. Changes are local to
 * this device (no Tier 2 student-sync endpoint yet - see PROJECT_CONTEXT).
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
  const [reissueId, setReissueId] = useState(null);
  const [printing, setPrinting] = useState(false);

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
      setError(err.message ?? 'Could not enrol the student');
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

  async function handleReissue(studentId) {
    setBusy(true);
    setReissueId(null);
    try {
      await issueCard(studentId);
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (printing) {
    return <CardList students={active} className={className} onClose={() => setPrinting(false)} />;
  }

  return (
    <div className="app">
      <TopBar title="Class Roster" onBack={onClose} />

      <div className="app__scroll">
        <p className="card__hint" style={{ marginTop: 4 }}>
          {className} · {active.length} student{active.length === 1 ? '' : 's'}
        </p>

        <form className="card" onSubmit={handleAdd}>
          <h2 className="card__title">Enrol a student</h2>
          <p className="card__hint">
            They join today’s roll call straight away and are issued an RFID card number.
          </p>

          {error && <div className="notice notice--err" role="alert">{error}</div>}

          <div className="field">
            <label className="field__label" htmlFor="rm-name">Full name</label>
            <input
              id="rm-name" className="field__input" type="text" autoComplete="off"
              placeholder="e.g. Amina Wanjiru" value={name}
              onChange={(e) => setName(e.target.value)} disabled={busy} required
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="rm-adm">Admission no. <span style={{ fontWeight: 400 }}>(optional)</span></label>
            <input
              id="rm-adm" className="field__input" type="text" autoComplete="off"
              placeholder="3B/011" value={admissionNo}
              onChange={(e) => setAdmissionNo(e.target.value)} disabled={busy}
            />
          </div>

          <button className="btn" type="submit" disabled={busy || name.trim() === ''}>
            {busy ? 'Working…' : 'Enrol student'}
          </button>
        </form>

        {active.length > 0 && (
          <button type="button" className="btn btn--secondary" onClick={() => setPrinting(true)}>
            Print card list ({active.length})
          </button>
        )}

        {loading ? (
          <p className="empty">Loading roster…</p>
        ) : active.length === 0 ? (
          <p className="empty">No students yet. Enrol the first one above.</p>
        ) : (
          <div className="roll" style={{ marginTop: 12 }}>
            {active.map((s) => (
              <div key={s.studentId} className="roll-row">
                <Avatar name={s.fullName} size="sm" />
                <div className="roll-row__who" style={{ cursor: 'default' }}>
                  <span className="roll-row__name">{s.fullName}</span>
                  <span className="roll-row__id">
                    Adm {s.admissionNo || '—'} · card <b>{s.cardUid || '—'}</b>
                    {' · '}
                    {reissueId === s.studentId ? (
                      <>
                        <button type="button" className="linkbtn linkbtn--inline" onClick={() => handleReissue(s.studentId)} disabled={busy}>
                          confirm new card
                        </button>
                        {' / '}
                        <button type="button" className="linkbtn linkbtn--inline linkbtn--muted" onClick={() => setReissueId(null)}>
                          cancel
                        </button>
                      </>
                    ) : (
                      <button type="button" className="linkbtn linkbtn--inline" onClick={() => setReissueId(s.studentId)} disabled={busy}>
                        reissue
                      </button>
                    )}
                  </span>
                </div>
                {confirmId === s.studentId ? (
                  <span className="roster-confirm">
                    <button type="button" className="linkbtn" onClick={() => handleRemove(s.studentId)} disabled={busy}>Remove</button>
                    <button type="button" className="linkbtn linkbtn--muted" onClick={() => setConfirmId(null)}>Cancel</button>
                  </span>
                ) : (
                  <button
                    type="button" className="roster-x" aria-label={`Remove ${s.fullName}`}
                    onClick={() => setConfirmId(s.studentId)} disabled={busy}
                  >×</button>
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
