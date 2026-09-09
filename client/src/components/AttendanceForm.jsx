import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  addAttendanceBatch,
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
    setLoading(false);
  }, [classGroupId, date]);

  useEffect(() => { load(); }, [load]);

  const draftedCount = useMemo(
    () => students.filter((s) => !(s.studentId in recorded) && draft[s.studentId]).length,
    [students, recorded, draft]
  );
  const markedCount = Object.keys(recorded).length + draftedCount;
  const total = students.length;
  const pct = total === 0 ? 0 : Math.round((markedCount / total) * 100);

  function choose(studentId, status) {
    setDraft((prev) => ({ ...prev, [studentId]: prev[studentId] === status ? undefined : status }));
    setResult(null);
  }

  function markRemainingPresent() {
    setDraft((prev) => {
      const next = { ...prev };
      for (const s of students) {
        if (!(s.studentId in recorded) && !next[s.studentId]) next[s.studentId] = 'present';
      }
      return next;
    });
    setResult(null);
  }

  async function handleSubmit() {
    setError(null);
    setSaving(true);
    try {
      const events = students
        .filter((s) => !(s.studentId in recorded) && draft[s.studentId])
        .map((s) => ({
          studentId: s.studentId,
          date,
          status: draft[s.studentId],
          captureMethod: 'manual',
          recordedBy: user?.username ?? null,
        }));

      if (events.length === 0) { setSaving(false); return; }

      const outcome = await addAttendanceBatch(events);
      setResult(outcome);
      setDraft({});
      await load();
      onRecordsChanged?.();
    } catch (err) {
      setError(err.message ?? 'Could not save attendance');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="empty">Loading class list…</p>;

  const allDone = total > 0 && Object.keys(recorded).length === total;

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
      {result && result.saved.length > 0 && (
        <div className="notice notice--ok" role="status">
          Saved {result.saved.length} record(s) to this device. They sync when there is a connection.
        </div>
      )}
      {result && result.duplicates.length > 0 && (
        <div className="notice notice--warn" role="status">
          {result.duplicates.length} already recorded today and were skipped.
        </div>
      )}
      {allDone && !result && (
        <div className="notice notice--ok" role="status">
          Attendance is complete for today. Each student can be recorded once per day.
        </div>
      )}

      {!allDone && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
          <button type="button" className="btn btn--ghost btn--sm" onClick={markRemainingPresent}>
            Mark rest present
          </button>
        </div>
      )}

      <div className="roll">
        {students.map((student) => {
          const locked = student.studentId in recorded;
          const value = locked ? recorded[student.studentId] : draft[student.studentId];
          return (
            <div key={student.studentId} className={`roll-row${value ? ' roll-row--marked' : ''}`}>
              <Avatar name={student.fullName} size="sm" />
              <button
                type="button"
                className="roll-row__who"
                onClick={() => onOpenProfile?.(student.studentId)}
              >
                <span className="roll-row__name">{student.fullName}</span>
                <span className="roll-row__id">ID: {student.admissionNo}</span>
              </button>

              {locked ? (
                <span className={`pill pill--${value}`}>{value}</span>
              ) : (
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
              )}
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
          disabled={saving || draftedCount === 0}
        >
          <CheckCircleIcon size={18} />
          {saving ? 'Saving…' : draftedCount > 0 ? `Submit Attendance (${draftedCount})` : 'Submit Attendance'}
        </button>
      </div>
    </>
  );
}
