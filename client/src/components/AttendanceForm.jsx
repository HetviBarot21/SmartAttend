import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  setAttendanceBatch,
  getStudentsByClass,
  getAttendanceForDate,
  todayISO,
} from '../db/database';
import { seedDatabase, seedDemoHistory } from '../db/seedData';
import { useAuth } from '../auth/AuthContext';
import { formatLongDate } from '../lib/attendanceSummary';
import Avatar from './Avatar';
import { SyncIcon, CheckCircleIcon } from './icons';

const STATUSES = [
  { code: 'present', short: 'P' },
  { code: 'absent', short: 'A' },
  { code: 'late', short: 'L' },
];

export default function AttendanceForm({ classGroupId, pending = 0, onRecordsChanged, onOpenProfile }) {
  const { user } = useAuth();
  const date = todayISO();

  const [students, setStudents] = useState([]);
  const [recorded, setRecorded] = useState({});
  const [draft, setDraft] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    await seedDatabase();
    await seedDemoHistory();
    const [roll, todays] = await Promise.all([
      getStudentsByClass(classGroupId),
      getAttendanceForDate(classGroupId, date),
    ]);
    setStudents(roll);
    setRecorded(Object.fromEntries(todays.map((r) => [r.studentId, r.status])));
    setDraft({});
    setLoading(false);
  }, [classGroupId, date]);

  useEffect(() => { load(); }, [load]);

  // The status a row currently shows: an unsaved edit if there is one, else the
  // saved value.
  const valueFor = useCallback(
    (studentId) => (studentId in draft ? draft[studentId] : recorded[studentId]),
    [draft, recorded],
  );

  // Rows whose shown status differs from what's saved - these get written on submit.
  const dirty = useMemo(
    () => students.filter((s) => s.studentId in draft && draft[s.studentId] !== recorded[s.studentId]),
    [students, draft, recorded],
  );
  const newCount = dirty.filter((s) => !(s.studentId in recorded)).length;
  const editCount = dirty.length - newCount;

  const markedCount = students.filter((s) => valueFor(s.studentId)).length;
  const total = students.length;
  const pct = total === 0 ? 0 : Math.round((markedCount / total) * 100);

  const valueForRaw = (draftMap, studentId) =>
    (studentId in draftMap ? draftMap[studentId] : recorded[studentId]);

  function choose(studentId, status) {
    setResult(null);
    setDraft((prev) => {
      const next = { ...prev };
      const saved = recorded[studentId];
      if (valueForRaw(prev, studentId) === status) {
        // tapping the shown status again cancels the pending change
        if (saved === undefined) delete next[studentId];
        else next[studentId] = saved;
      } else {
        next[studentId] = status;
      }
      return next;
    });
  }

  function markRemainingPresent() {
    setResult(null);
    setDraft((prev) => {
      const next = { ...prev };
      for (const s of students) {
        if (!valueForRaw(next, s.studentId)) next[s.studentId] = 'present';
      }
      return next;
    });
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

      if (events.length === 0) { setSaving(false); return; }

      const outcome = await setAttendanceBatch(events);
      setResult(outcome);
      await load();
      onRecordsChanged?.();
    } catch (err) {
      setError(err.message ?? 'Could not save attendance');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="empty">Loading class list…</p>;

  const allMarked = total > 0 && markedCount === total;
  const savedMsg = result && result.saved.length > 0
    ? [
        result.created.length ? `${result.created.length} new` : null,
        result.updated.length ? `${result.updated.length} changed` : null,
      ].filter(Boolean).join(', ')
    : null;

  return (
    <>
      <div className="roll-head">
        <div className="roll-head__row">
          <span className="card__hint" style={{ margin: 0 }}>{formatLongDate(date)}</span>
          <span className="roll-head__count">{markedCount} / {total} marked</span>
        </div>
        <div className="progress">
          <div className="progress__fill" style={{ width: `${pct}%` }} />
        </div>
      </div>

      {error && <div className="notice notice--err" role="alert">{error}</div>}
      {savedMsg && (
        <div className="notice notice--ok" role="status">
          Saved ({savedMsg}) to this device. Changes sync when there is a connection.
        </div>
      )}
      {result && result.failed.length > 0 && (
        <div className="notice notice--err" role="alert">
          {result.failed.length} record(s) could not be saved.
        </div>
      )}
      {allMarked && !result && (
        <div className="notice notice--ok" role="status">
          Everyone is marked for today. Tap a status to correct it — attendance stays editable all day.
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={markRemainingPresent}
          disabled={allMarked && dirty.length === 0}
        >
          Mark rest present
        </button>
      </div>

      <div className="roll">
        {students.map((student) => {
          const value = valueFor(student.studentId);
          const isEdit = student.studentId in draft && draft[student.studentId] !== recorded[student.studentId];
          return (
            <div
              key={student.studentId}
              className={`roll-row${value ? ' roll-row--marked' : ''}${isEdit ? ' roll-row--edited' : ''}`}
            >
              <Avatar name={student.fullName} size="sm" />
              <button
                type="button"
                className="roll-row__who"
                onClick={() => onOpenProfile?.(student.studentId)}
              >
                <span className="roll-row__name">{student.fullName}</span>
                <span className="roll-row__id">
                  ID: {student.admissionNo || '—'}
                  {student.studentId in recorded ? ` · saved: ${recorded[student.studentId]}` : ''}
                </span>
              </button>

              <div className="pal" role="group" aria-label={`Attendance for ${student.fullName}`}>
                {STATUSES.map(({ code, short }) => (
                  <button
                    key={code}
                    type="button"
                    className="pal__btn"
                    data-status={code}
                    aria-pressed={value === code}
                    aria-label={code}
                    onClick={() => choose(student.studentId, code)}
                    disabled={saving}
                  >
                    {short}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* keeps the last row clear of the fixed submit bar */}
      <div aria-hidden="true" style={{ height: 132 }} />

      <div className="rollbar">
        <div className="rollbar__meta">
          <SyncIcon size={14} />
          {pending > 0 ? `${pending} pending sync${pending === 1 ? '' : 's'}` : 'All records synced'}
        </div>
        <button
          type="button"
          className="btn"
          onClick={handleSubmit}
          disabled={saving || dirty.length === 0}
        >
          <CheckCircleIcon size={18} />
          {saving
            ? 'Saving…'
            : dirty.length > 0
              ? `Save${editCount ? ' changes' : ''} (${dirty.length})`
              : 'Save Attendance'}
        </button>
      </div>
    </>
  );
}
