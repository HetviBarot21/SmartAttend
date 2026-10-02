import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getStudentsByClass,
  addStudent,
  updateStudent,
  removeStudent,
  issueCard,
} from '../db/database';
import { generateSampleHistory } from '../db/seedData';
import { requestBackgroundSync } from '../services/syncService';
import Avatar from './Avatar';
import CardList from './CardList';
import { SearchIcon, PhoneIcon, MailIcon } from './icons';
import { showToast } from '../lib/toast';

/** Class roster editor: enrol and remove students, reissue lost cards. */
export default function RosterManager({ classGroupId, className }) {
  const [active, setActive] = useState([]);
  const [removed, setRemoved] = useState([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [admissionNo, setAdmissionNo] = useState('');
  const [guardianPhone, setGuardianPhone] = useState('');
  const [guardianEmail, setGuardianEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirmId, setConfirmId] = useState(null);
  const [reissueId, setReissueId] = useState(null);
  const [printing, setPrinting] = useState(false);
  const [sampleNotice, setSampleNotice] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [query, setQuery] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const selectAllRef = useRef(null);

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
      await addStudent({ classGroupId, fullName: name, admissionNo, guardianPhone, guardianEmail });
      showToast(`${name.trim()} enrolled in ${className}`);
      setName('');
      setAdmissionNo('');
      setGuardianPhone('');
      setGuardianEmail('');
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
      showToast('Student removed');
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveSelected() {
    const ids = active.filter((s) => selected.has(s.studentId)).map((s) => s.studentId);
    if (ids.length === 0) return;
    if (!window.confirm(`Remove ${ids.length} student${ids.length === 1 ? '' : 's'} from ${className}? Students with attendance history can be restored.`)) return;
    setBusy(true);
    try {
      for (const id of ids) await removeStudent(id);
      showToast(`${ids.length} student${ids.length === 1 ? '' : 's'} removed`);
      setSelected(new Set());
      await load();
    } finally {
      setBusy(false);
    }
  }

  function toggleSelected(studentId) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(studentId)) next.delete(studentId);
      else next.add(studentId);
      return next;
    });
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

  async function handleGenerateSample() {
    setGenerating(true);
    setSampleNotice(null);
    try {
      const result = await generateSampleHistory(classGroupId);
      if (result.seeded) {
        setSampleNotice(`Generated ${result.count} records for ${result.studentCount} student(s). Check Heatmap and Alerts.`);
        requestBackgroundSync().catch(() => {});
      } else {
        setSampleNotice(result.reason);
      }
    } catch (err) {
      setSampleNotice(err.message ?? 'Could not generate sample attendance');
    } finally {
      setGenerating(false);
    }
  }

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return active;
    return active.filter((s) => s.fullName.toLowerCase().includes(q) || String(s.admissionNo ?? '').toLowerCase().includes(q));
  }, [active, query]);
  const selectedVisible = visible.filter((s) => selected.has(s.studentId)).length;
  const allSelected = visible.length > 0 && selectedVisible === visible.length;
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = selectedVisible > 0 && !allSelected;
  }, [selectedVisible, allSelected]);

  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const s of visible) {
        if (allSelected) next.delete(s.studentId);
        else next.add(s.studentId);
      }
      return next;
    });
  }

  const showForm = formOpen || (!loading && active.length === 0);

  if (printing) {
    return <CardList students={active} className={className} onClose={() => setPrinting(false)} />;
  }

  return (
    <>
        <div className="page-head">
          <div>
            <h2 className="page-head__title">Students</h2>
            <p className="page-head__sub">
              {className} · {active.length} student{active.length === 1 ? '' : 's'} enrolled
            </p>
          </div>
          <div className="page-head__actions">
            {active.length > 0 && (
              <>
                <button type="button" className="btn btn--outline btn--sm" onClick={handleGenerateSample} disabled={generating}>
                  {generating ? 'Generating…' : 'Generate sample month'}
                </button>
                <button type="button" className="btn btn--outline btn--sm" onClick={() => setPrinting(true)}>
                  Print card list
                </button>
              </>
            )}
            <button type="button" className="btn btn--sm" onClick={() => setFormOpen((o) => !o)}>
              {showForm && active.length > 0 ? 'Close form' : '+ Add student'}
            </button>
          </div>
        </div>

        {sampleNotice && <div className="notice notice--info" role="status">{sampleNotice}</div>}

        {showForm && (
          <form className="panel panel--pad" onSubmit={handleAdd}>
            <div className="panel__head">
              <div>
                <h3 className="panel__title">Enrol a student</h3>
                <p className="panel__sub">They join today&apos;s register straight away and are issued an RFID card number.</p>
              </div>
            </div>

            {error && <div className="notice notice--err" role="alert">{error}</div>}

            <div className="form-grid">
              <div className="field">
                <label className="field__label" htmlFor="rm-name">Full name</label>
                <input
                  id="rm-name" className="field__input" type="text" autoComplete="off"
                  placeholder="e.g. Amina Wanjiru" value={name}
                  onChange={(e) => setName(e.target.value)} disabled={busy} required
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="rm-adm">Admission no. <span className="field__opt">(optional)</span></label>
                <input
                  id="rm-adm" className="field__input" type="text" autoComplete="off"
                  placeholder="3B/011" value={admissionNo}
                  onChange={(e) => setAdmissionNo(e.target.value)} disabled={busy}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="rm-phone">Guardian phone <span className="field__opt">(optional)</span></label>
                <input
                  id="rm-phone" className="field__input" type="tel" autoComplete="off"
                  placeholder="+254 7..." value={guardianPhone}
                  onChange={(e) => setGuardianPhone(e.target.value)} disabled={busy}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="rm-email">Guardian email <span className="field__opt">(optional)</span></label>
                <input
                  id="rm-email" className="field__input" type="email" autoComplete="off"
                  placeholder="parent@example.com" value={guardianEmail}
                  onChange={(e) => setGuardianEmail(e.target.value)} disabled={busy}
                />
              </div>
            </div>

            <div className="form-actions">
              <button className="btn btn--sm" type="submit" disabled={busy || name.trim() === ''}>
                {busy ? 'Working…' : 'Enrol student'}
              </button>
            </div>
          </form>
        )}

        <div className="panel">
          <div className="panel__toolbar">
            <div className="search">
              <SearchIcon size={16} />
              <input
                type="search"
                placeholder="Search by name or admission no."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search students"
              />
            </div>
            {selected.size > 0 && (
              <div className="bulkbar" role="status">
                <span><b>{selected.size}</b> selected</span>
                <button type="button" className="btn btn--danger btn--sm" onClick={handleRemoveSelected} disabled={busy}>
                  Remove selected
                </button>
                <button type="button" className="linkbtn" onClick={() => setSelected(new Set())}>Clear</button>
              </div>
            )}
          </div>

          {loading ? (
            <p className="empty">Loading students…</p>
          ) : active.length === 0 ? (
            <p className="empty">No students yet. Use the form above to enrol the first one.</p>
          ) : (
            <div className="table-wrap">
              <table className="table roster-table">
                <thead>
                  <tr>
                    <th className="col-select">
                      <input
                        ref={selectAllRef}
                        type="checkbox"
                        className="check check--select"
                        checked={allSelected}
                        onChange={toggleAll}
                        aria-label="Select all students"
                      />
                    </th>
                    <th>Student</th>
                    <th className="col-hide-sm">Adm. No.</th>
                    <th className="col-hide-sm">RFID card</th>
                    <th className="col-hide-sm">Guardian</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {visible.length === 0 && (
                    <tr><td colSpan={6} className="table__empty">No students match.</td></tr>
                  )}
                  {visible.map((s) => (
                    <tr key={s.studentId} className={selected.has(s.studentId) ? 'row--selected' : undefined}>
                      <td className="col-select">
                        <input
                          type="checkbox"
                          className="check check--select"
                          checked={selected.has(s.studentId)}
                          onChange={() => toggleSelected(s.studentId)}
                          aria-label={`Select ${s.fullName}`}
                        />
                      </td>
                      <td>
                        <div className="student-cell student-cell--static">
                          <Avatar name={s.fullName} size="sm" />
                          <span className="student-cell__text">
                            <span className="student-cell__name">{s.fullName}</span>
                            <span className="student-cell__sub">{s.admissionNo || '-'}</span>
                          </span>
                        </div>
                      </td>
                      <td className="col-hide-sm">{s.admissionNo || '-'}</td>
                      <td className="col-hide-sm">
                        <span className="mono">{s.cardUid || 'Not issued'}</span>
                        {' '}
                        {reissueId === s.studentId ? (
                          <>
                            <button type="button" className="linkbtn linkbtn--inline" onClick={() => handleReissue(s.studentId)} disabled={busy}>
                              Confirm
                            </button>
                            {' / '}
                            <button type="button" className="linkbtn linkbtn--inline linkbtn--muted" onClick={() => setReissueId(null)}>
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button type="button" className="linkbtn linkbtn--inline" onClick={() => setReissueId(s.studentId)} disabled={busy}>
                            {s.cardUid ? 'Reissue' : 'Issue'}
                          </button>
                        )}
                      </td>
                      <td className="col-hide-sm">
                        <span className="student-cell__sub">
                          {s.guardianPhone && <a className="inline-link" href={`tel:${s.guardianPhone}`}><PhoneIcon size={12} /> {s.guardianPhone}</a>}
                          {s.guardianEmail && <a className="inline-link" href={`mailto:${s.guardianEmail}`}><MailIcon size={12} /> {s.guardianEmail}</a>}
                          {!s.guardianPhone && !s.guardianEmail && '-'}
                        </span>
                      </td>
                      <td className="cell-action">
                        {confirmId === s.studentId ? (
                          <span className="roster-confirm">
                            <button type="button" className="linkbtn" onClick={() => handleRemove(s.studentId)} disabled={busy}>Remove</button>
                            <button type="button" className="linkbtn linkbtn--muted" onClick={() => setConfirmId(null)}>Cancel</button>
                          </span>
                        ) : (
                          <button
                            type="button" className="btn btn--outline btn--sm"
                            onClick={() => setConfirmId(s.studentId)} disabled={busy}
                            aria-label={`Remove ${s.fullName}`}
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {removed.length > 0 && (
          <div className="panel">
            <div className="panel__head panel__head--pad">
              <div>
                <h3 className="panel__title">Removed students</h3>
                <p className="panel__sub">Attendance history is kept. Restore to put them back on the register.</p>
              </div>
            </div>
            <div className="table-wrap">
              <table className="table">
                <tbody>
                  {removed.map((s) => (
                    <tr key={s.studentId}>
                      <td>
                        <div className="student-cell student-cell--static student-cell--muted">
                          <Avatar name={s.fullName} size="sm" />
                          <span className="student-cell__text">
                            <span className="student-cell__name">{s.fullName}</span>
                            <span className="student-cell__sub">{s.admissionNo || '-'}</span>
                          </span>
                        </div>
                      </td>
                      <td className="cell-action">
                        <button type="button" className="btn btn--outline btn--sm" onClick={() => handleRestore(s.studentId)} disabled={busy}>
                          Restore
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
    </>
  );
}
