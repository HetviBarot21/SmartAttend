import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  setAttendanceBatch,
  getStudentsByClass,
  getAttendanceForDate,
  todayISO,
  GATE_CAPTURE_METHODS,
} from '../db/database';
import { pullGateAttendance } from '../services/gateService';
import { useAuth } from '../auth/AuthContext';
import { formatLongDate } from '../lib/attendanceSummary';
import { isSchoolDay } from '../lib/riskModel';
import { showToast } from '../lib/toast';
import Avatar from './Avatar';
import { SyncIcon, SearchIcon } from './icons';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'present', label: 'Present' },
  { id: 'absent', label: 'Absent' },
];

const REASONS = [
  { code: 'fee', label: 'Fees' },
  { code: 'health', label: 'Sick' },
  { code: 'other', label: 'Other' },
  { code: 'unknown', label: "Don't know" },
];

// A late record (e.g. from a gate scan after the bell) still counts as present here.
const isPresent = (status) => status === 'present' || status === 'late';

const timeOf = (iso) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

/**
 * Class register. Without the school gate every student starts ticked present
 * and the teacher unticks whoever is absent. With the gate running, students
 * who scanned in are already present and the ones who did not start unticked,
 * so the teacher only ticks late arrivals and gives absence reasons.
 */
export default function AttendanceForm({ classGroupId, pending = 0, onRecordsChanged, onOpenProfile, onDirtyChange }) {
  const { user } = useAuth();
  const today = todayISO();
  const [date, setDate] = useState(today);

  const [students, setStudents] = useState([]);
  // studentId -> the saved Dexie record for this date
  const [saved, setSaved] = useState({});
  const [draft, setDraft] = useState({});
  const [reasonDraft, setReasonDraft] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [touched, setTouched] = useState(false); // the teacher changed something since the last save
  // null while the gate check is in flight; only checked for today's register
  const [gate, setGate] = useState(null);
  const [checkingGate, setCheckingGate] = useState(false);
  const [conflicts, setConflicts] = useState([]);
  const headerRef = useRef(null);

  const readLocal = useCallback(async () => {
    const [roll, records] = await Promise.all([
      getStudentsByClass(classGroupId),
      getAttendanceForDate(classGroupId, date),
    ]);
    setStudents(roll);
    setSaved(Object.fromEntries(records.map((r) => [r.studentId, r])));
    setLoading(false);
  }, [classGroupId, date]);

  // Pull what the gate has recorded, merge it, then re-read. Unsaved ticks are
  // kept: a gate refresh must never wipe what the teacher is doing.
  const refreshGate = useCallback(async () => {
    if (date !== today) return;
    setCheckingGate(true);
    try {
      const outcome = await pullGateAttendance(classGroupId, { date });
      setGate(outcome);
      if (outcome.replaced.length > 0) setConflicts(outcome.replaced);
      if (outcome.added.length || outcome.updated.length || outcome.replaced.length) {
        await readLocal();
        onRecordsChanged?.();
      }
    } finally {
      setCheckingGate(false);
    }
  }, [classGroupId, date, today, readLocal, onRecordsChanged]);

  // Local records first (instant, works offline), then the gate on top.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await readLocal();
      if (!cancelled) await refreshGate();
    })();
    return () => { cancelled = true; };
  }, [readLocal, refreshGate]);

  const recorded = useMemo(
    () => Object.fromEntries(Object.entries(saved).map(([id, r]) => [id, r.status])),
    [saved],
  );

  const gateActive = date === today && gate?.status === 'active';
  // Status for a student with no record yet: with the gate running, no scan means absent.
  const defaultStatus = gateActive ? 'absent' : 'present';

  const valueFor = useCallback(
    (studentId) => (studentId in draft ? draft[studentId] : recorded[studentId] ?? defaultStatus),
    [draft, recorded, defaultStatus],
  );
  const savedReason = useCallback((studentId) => saved[studentId]?.reason ?? null, [saved]);
  const reasonFor = useCallback(
    (studentId) => (studentId in reasonDraft ? reasonDraft[studentId] : savedReason(studentId)),
    [reasonDraft, savedReason],
  );

  // Rows whose status or absence reason differs from what is saved; these are written on save.
  const dirty = useMemo(
    () => students.filter((s) => {
      const status = valueFor(s.studentId);
      if (status !== recorded[s.studentId]) return true;
      return status === 'absent' && reasonFor(s.studentId) !== savedReason(s.studentId);
    }),
    [students, valueFor, recorded, reasonFor, savedReason],
  );

  const isGateRecord = (studentId) => GATE_CAPTURE_METHODS.includes(saved[studentId]?.captureMethod);
  const atGateCount = students.filter((s) => isGateRecord(s.studentId)).length;

  const counts = useMemo(() => {
    const c = { all: students.length, present: 0, absent: 0 };
    for (const s of students) c[isPresent(valueFor(s.studentId)) ? 'present' : 'absent'] += 1;
    return c;
  }, [students, valueFor]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return students.filter((s) => {
      const present = isPresent(valueFor(s.studentId));
      if (filter === 'present' && !present) return false;
      if (filter === 'absent' && present) return false;
      if (!q) return true;
      return s.fullName.toLowerCase().includes(q) || String(s.admissionNo ?? '').toLowerCase().includes(q);
    });
  }, [students, valueFor, query, filter]);

  const visiblePresent = visible.filter((s) => isPresent(valueFor(s.studentId))).length;
  const allTicked = visible.length > 0 && visiblePresent === visible.length;
  useEffect(() => {
    if (headerRef.current) headerRef.current.indeterminate = visiblePresent > 0 && !allTicked;
  }, [visiblePresent, allTicked]);

  // Tell the app about unsaved edits so leaving the page can ask first.
  const unsaved = touched && dirty.length > 0;
  useEffect(() => {
    onDirtyChange?.(unsaved);
    if (!unsaved) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  // Ticking keeps a saved "late" as it was; unticking is always absent.
  function statusFor(studentId, present) {
    if (present) return isPresent(recorded[studentId]) ? recorded[studentId] : 'present';
    return 'absent';
  }

  function setPresent(ids, present) {
    setResult(null);
    setTouched(true);
    setDraft((prev) => {
      const next = { ...prev };
      for (const id of ids) next[id] = statusFor(id, present);
      return next;
    });
  }

  function chooseReason(studentId, code) {
    setResult(null);
    setTouched(true);
    setReasonDraft((prev) => ({ ...prev, [studentId]: code || null }));
  }

  function resetDrafts() {
    setDraft({});
    setReasonDraft({});
    setTouched(false);
  }

  function changeDate(next) {
    if (!next || next > today) return;
    if (unsaved && !window.confirm('You have unsaved changes. Discard them and switch date?')) return;
    resetDrafts();
    setResult(null);
    setError(null);
    setGate(null);
    setConflicts([]);
    setLoading(true);
    setDate(next);
  }

  async function handleSubmit() {
    setError(null);
    setSaving(true);
    try {
      const events = dirty.map((s) => {
        const status = valueFor(s.studentId);
        return {
          studentId: s.studentId,
          date,
          status,
          reason: status === 'absent' ? reasonFor(s.studentId) : null,
          captureMethod: 'manual',
          recordedBy: user?.username ?? null,
        };
      });
      if (events.length === 0) return;

      const outcome = await setAttendanceBatch(events);
      setResult(outcome);
      if (outcome.saved.length > 0) {
        showToast(`Attendance saved for ${formatLongDate(date)}: ${counts.present} present, ${counts.absent} absent`);
      }
      resetDrafts();
      await readLocal();
      onRecordsChanged?.();
    } catch (err) {
      setError(err.message ?? 'Could not save attendance');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="empty">Loading class list…</p>;

  const nameOf = (studentId) => students.find((s) => s.studentId === studentId)?.fullName ?? studentId;
  const nothingSaved = students.every((s) => !(s.studentId in recorded));
  const verb = gateActive ? 'Confirm' : 'Save';

  return (
    <div className="register">
      <div className="page-head">
        <div>
          <h2 className="page-head__title">Class register</h2>
          <p className="page-head__sub">
            {formatLongDate(date)}
            {date === today ? ' (today)' : ''}
            {!isSchoolDay(date) ? ' · weekend' : ''}
          </p>
        </div>
        <div className="page-head__actions">
          <label className="date-input">
            <span className="sr-only">Register date</span>
            <input
              type="date"
              value={date}
              max={today}
              onChange={(e) => changeDate(e.target.value)}
            />
          </label>
        </div>
      </div>

      {date === today && (
        <GateBanner gate={gate} checking={checkingGate} atGateCount={atGateCount} total={students.length} onRefresh={refreshGate} />
      )}

      {conflicts.length > 0 && (
        <div className="notice notice--warn conflict-note" role="alert">
          <div>
            {conflicts.map((c) => (
              <div key={c.studentId}>
                {nameOf(c.studentId)} {GATE_CAPTURE_METHODS.includes(c.captureMethod)
                  ? `scanned in at the gate at ${timeOf(c.createdAt)}`
                  : `was already marked ${c.serverStatus} on the school system`}
                {' '}- your &quot;{c.localStatus}&quot; mark was replaced.
              </div>
            ))}
          </div>
          <button type="button" className="btn btn--outline btn--sm" onClick={() => setConflicts([])}>OK</button>
        </div>
      )}

      {error && <div className="notice notice--err" role="alert">{error}</div>}
      {result && result.failed.length > 0 && (
        <div className="notice notice--err" role="alert">
          {result.failed.length} record(s) could not be saved.
        </div>
      )}
      {nothingSaved && !gateActive && !result && students.length > 0 && (
        <div className="notice notice--info" role="status">
          Everyone is ticked as present. Untick the students who are absent, add a reason if you know it, then save.
        </div>
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
          <div className="chips" role="tablist" aria-label="Filter by status">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={filter === f.id}
                className={`chip chip--${f.id}`}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
                <span className="chip__count">{counts[f.id]}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="table-wrap">
          <table className="table register-table">
            <thead>
              <tr>
                <th className="col-check">
                  <input
                    ref={headerRef}
                    type="checkbox"
                    className="check check--present"
                    checked={allTicked}
                    onChange={() => setPresent(visible.map((s) => s.studentId), !allTicked)}
                    disabled={saving || visible.length === 0}
                    aria-label={allTicked ? 'Mark everyone shown absent' : 'Mark everyone shown present'}
                  />
                </th>
                <th className="col-num">#</th>
                <th>Student</th>
                <th className="col-adm">Adm. No.</th>
                <th className="col-state">Status</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr>
                  <td colSpan={5} className="table__empty">
                    {students.length === 0 ? 'No students in this class yet. Add them under Students.' : 'No students match.'}
                  </td>
                </tr>
              )}
              {visible.map((student) => {
                const id = student.studentId;
                const status = valueFor(id);
                const present = isPresent(status);
                const record = saved[id];
                const changed = id in recorded && dirty.some((s) => s.studentId === id);
                const fromGate = isGateRecord(id) && !(id in draft && draft[id] !== recorded[id]);
                return (
                  <tr key={id} className={`${present ? '' : 'row--absent'}${changed ? ' row--edited' : ''}`}>
                    <td className="col-check">
                      <input
                        type="checkbox"
                        className="check check--present"
                        checked={present}
                        onChange={() => setPresent([id], !present)}
                        disabled={saving}
                        aria-label={`${student.fullName} present`}
                      />
                    </td>
                    <td className="col-num">{students.indexOf(student) + 1}</td>
                    <td>
                      <button
                        type="button"
                        className="student-cell"
                        onClick={() => onOpenProfile?.(id)}
                        title="Open student profile"
                      >
                        <Avatar name={student.fullName} size="sm" />
                        <span className="student-cell__text">
                          <span className="student-cell__name">{student.fullName}</span>
                          <span className="student-cell__sub">{student.admissionNo || '-'}</span>
                        </span>
                      </button>
                    </td>
                    <td className="col-adm">{student.admissionNo || '-'}</td>
                    <td className="col-state">
                      <div className="state-cell">
                        <span className={`badge ${present ? 'badge--ok' : 'badge--danger-soft'}`}>
                          {status === 'late' ? 'Late' : present ? 'Present' : 'Absent'}
                        </span>
                        {!present && (
                          <select
                            className="reason-select"
                            value={reasonFor(id) ?? ''}
                            onChange={(e) => chooseReason(id, e.target.value)}
                            disabled={saving}
                            aria-label={`Why was ${student.fullName} absent?`}
                          >
                            <option value="">Reason…</option>
                            {REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
                          </select>
                        )}
                        {fromGate ? (
                          <span className="state-note">
                            gate {timeOf(record.createdAt)}{record.captureMethod === 'fingerprint' ? ' (fingerprint)' : ''}
                          </span>
                        ) : changed ? (
                          <span className="state-note">changed</span>
                        ) : !(id in recorded) ? (
                          <span className="state-note">{gateActive ? 'not scanned' : 'not saved'}</span>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="savebar">
        <div className="savebar__meta">
          <SyncIcon size={14} />
          <span>
            <b>{counts.present}</b> present · <b>{counts.absent}</b> absent
            <span className="savebar__sync">
              {' · '}
              {pending > 0 ? `${pending} record${pending === 1 ? '' : 's'} waiting to sync` : 'all synced'}
            </span>
          </span>
        </div>
        <div className="savebar__actions">
          {touched && dirty.length > 0 && (
            <button type="button" className="btn btn--outline btn--sm" onClick={resetDrafts} disabled={saving}>
              Discard
            </button>
          )}
          <button
            type="button"
            className="btn btn--sm"
            onClick={handleSubmit}
            disabled={saving || dirty.length === 0}
          >
            {saving ? 'Saving…' : dirty.length > 0 ? `${verb} attendance (${dirty.length})` : 'Saved'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** What the gate knows, or why the teacher is on a full manual roll call. */
function GateBanner({ gate, checking, atGateCount, total, onRefresh }) {
  if (!gate) {
    return <div className="notice notice--info gate-banner" role="status"><span>Checking the school gate…</span></div>;
  }

  const copy = {
    active: {
      tone: 'ok',
      text: `${atGateCount} of ${total} scanned in at the gate (last scan ${timeOf(gate.lastScanAt)}). Students who did not scan are unticked: tick anyone who is here and give reasons for the rest.`,
    },
    'no-scans': {
      tone: 'warn',
      text: 'No gate scans yet today. If students have arrived, the gate may be down: take a full roll call.',
    },
    unreachable: {
      tone: 'info',
      text: "Can't reach the school gate, so take a full roll call. Marks save on this device and sync later.",
    },
    'unknown-class': {
      tone: 'info',
      text: "This class isn't on the school gate yet. Take the roll call as usual.",
    },
  }[gate.status];

  return (
    <div className={`notice notice--${copy.tone} gate-banner`} role="status">
      <span>{copy.text}</span>
      <button type="button" className="btn btn--outline btn--sm" onClick={onRefresh} disabled={checking}>
        {checking ? 'Checking…' : 'Refresh'}
      </button>
    </div>
  );
}
