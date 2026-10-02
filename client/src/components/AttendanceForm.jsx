import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  setAttendanceBatch,
  getStudentsByClass,
  getAttendanceForDate,
  todayISO,
} from '../db/database';
import { useAuth } from '../auth/AuthContext';
import { formatLongDate } from '../lib/attendanceSummary';
import { isSchoolDay } from '../lib/riskModel';
import Avatar from './Avatar';
import { SyncIcon, SearchIcon } from './icons';
import { showToast } from '../lib/toast';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'present', label: 'Present' },
  { id: 'absent', label: 'Absent' },
];

// A late record (e.g. from an RFID scan) still counts as present here.
const isPresent = (status) => status === 'present' || status === 'late';

/**
 * Class register. Every student starts ticked as present; the teacher unticks
 * whoever is absent and saves.
 */
export default function AttendanceForm({ classGroupId, pending = 0, onRecordsChanged, onOpenProfile, onDirtyChange }) {
  const { user } = useAuth();
  const today = todayISO();
  const [date, setDate] = useState(today);

  const [students, setStudents] = useState([]);
  const [recorded, setRecorded] = useState({});
  const [draft, setDraft] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const headerRef = useRef(null);
  const [touched, setTouched] = useState(false); // the teacher changed something since the last save

  const load = useCallback(async () => {
    const [roll, todays] = await Promise.all([
      getStudentsByClass(classGroupId),
      getAttendanceForDate(classGroupId, date),
    ]);
    const saved = Object.fromEntries(todays.map((r) => [r.studentId, r.status]));
    setStudents(roll);
    setRecorded(saved);
    // Default anyone not yet recorded to present.
    setDraft(Object.fromEntries(roll.filter((s) => !(s.studentId in saved)).map((s) => [s.studentId, 'present'])));
    setTouched(false);
    setLoading(false);
  }, [classGroupId, date]);

  useEffect(() => { load(); }, [load]);

  const valueFor = useCallback(
    (studentId) => (studentId in draft ? draft[studentId] : recorded[studentId]),
    [draft, recorded],
  );

  const dirty = useMemo(
    () => students.filter((s) => s.studentId in draft && draft[s.studentId] !== recorded[s.studentId]),
    [students, draft, recorded],
  );
  const savedCount = students.filter((s) => s.studentId in recorded).length;
  const firstSave = savedCount === 0;

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

  // Present keeps a saved "late" as it was; absent is always absent.
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

  function changeDate(next) {
    if (!next || next > today) return;
    if (savedCount > 0 && dirty.length > 0 && !window.confirm('You have unsaved changes. Discard them and switch date?')) return;
    setResult(null);
    setError(null);
    setLoading(true);
    setDate(next);
  }

  async function handleSubmit() {
    setError(null);
    setSaving(true);
    try {
      const events = dirty.map((s) => ({
        studentId: s.studentId,
        date,
        status: draft[s.studentId],
        captureMethod: 'manual',
        recordedBy: user?.username ?? null,
      }));
      if (events.length === 0) return;

      const outcome = await setAttendanceBatch(events);
      setResult(outcome);
      if (outcome.saved.length > 0) {
        showToast(`Attendance saved for ${formatLongDate(date)}: ${counts.present} present, ${counts.absent} absent`);
      }
      await load();
      onRecordsChanged?.();
    } catch (err) {
      setError(err.message ?? 'Could not save attendance');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="empty">Loading class list…</p>;

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

      {error && <div className="notice notice--err" role="alert">{error}</div>}
      {result && result.failed.length > 0 && (
        <div className="notice notice--err" role="alert">
          {result.failed.length} record(s) could not be saved.
        </div>
      )}
      {firstSave && !result && students.length > 0 && (
        <div className="notice notice--info" role="status">
          Everyone is ticked as present. Untick the students who are absent, then save.
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
                const present = isPresent(valueFor(id));
                const changed = id in recorded && id in draft && draft[id] !== recorded[id];
                return (
                  <tr
                    key={id}
                    className={`${present ? '' : 'row--absent'}${changed ? ' row--edited' : ''}`}
                  >
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
                      <span className={`badge ${present ? 'badge--ok' : 'badge--danger-soft'}`}>
                        {present ? 'Present' : 'Absent'}
                      </span>
                      {changed && <span className="state-note">changed</span>}
                      {!(id in recorded) && <span className="state-note">not saved</span>}
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
            {' · '}
            {pending > 0 ? `${pending} record${pending === 1 ? '' : 's'} waiting to sync` : 'all synced'}
          </span>
        </div>
        <div className="savebar__actions">
          {!firstSave && dirty.length > 0 && (
            <button type="button" className="btn btn--outline btn--sm" onClick={load} disabled={saving}>
              Discard
            </button>
          )}
          <button
            type="button"
            className="btn btn--sm"
            onClick={handleSubmit}
            disabled={saving || dirty.length === 0}
          >
            {saving
              ? 'Saving…'
              : firstSave
                ? 'Save attendance'
                : dirty.length > 0
                  ? `Save changes (${dirty.length})`
                  : 'Saved'}
          </button>
        </div>
      </div>
    </div>
  );
}
