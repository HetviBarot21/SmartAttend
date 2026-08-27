import { useCallback, useEffect, useState } from 'react';
import {
  addAttendanceBatch,
  getStudentsByClass,
  getAttendanceForDate,
  todayISO,
  ATTENDANCE_STATUSES
} from '../db/database';
import { seedDatabase } from '../db/seedData';
import { useAuth } from '../auth/AuthContext';
import { formatLongDate } from '../lib/attendanceSummary';

const LABELS = { present: 'Present', absent: 'Absent', late: 'Late' };

export default function AttendanceForm({ classGroupId, onRecordsChanged }) {
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
    const [roll, todays] = await Promise.all([
      getStudentsByClass(classGroupId),
      getAttendanceForDate(classGroupId, date)
    ]);
    setStudents(roll);
    setRecorded(Object.fromEntries(todays.map((r) => [r.studentId, r.status])));
    setLoading(false);
  }, [classGroupId, date]);

  useEffect(() => { load(); }, [load]);

  const pending = students.filter((s) => !(s.studentId in recorded));
  const unmarked = pending.filter((s) => !draft[s.studentId]);

  function choose(studentId, status) {
    setDraft((prev) => ({ ...prev, [studentId]: status }));
    setResult(null);
  }

  function markAllPresent() {
    setDraft((prev) => {
      const next = { ...prev };
      for (const s of pending) if (!next[s.studentId]) next[s.studentId] = 'present';
      return next;
    });
    setResult(null);
  }

  async function handleSubmit() {
    setError(null);
    setSaving(true);
    try {
      const events = pending.map((s) => ({
        studentId: s.studentId,
        date,
        status: draft[s.studentId],
        captureMethod: 'manual',
        recordedBy: user?.username ?? null
      }));

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

  /**
   * Demo only: replays today's roll call so the unique index rejects every
   * record. Proves duplicate prevention is enforced by IndexedDB rather than
   * by the form disabling its own buttons.
   */
  async function replayForDuplicateCheck() {
    setError(null);
    setSaving(true);
    try {
      const events = students.map((s) => ({
        studentId: s.studentId,
        date,
        status: recorded[s.studentId] ?? 'present',
        captureMethod: 'manual',
        recordedBy: user?.username ?? null
      }));
      setResult(await addAttendanceBatch(events));
      await load();
      onRecordsChanged?.();
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="empty">Loading class list…</p>;

  const allRecorded = pending.length === 0;

  return (
    <section>
      <p className="card__hint" style={{ marginTop: 0 }}>{formatLongDate(date)}</p>

      {error && <div className="notice notice--err" role="alert">{error}</div>}

      {result && (
        <div
          className={`notice ${result.saved.length > 0 ? 'notice--ok' : 'notice--warn'}`}
          role="status"
        >
          {result.saved.length > 0 && (
            <>Saved {result.saved.length} record(s) to this device. They will sync when there is a connection.</>
          )}
          {result.duplicates.length > 0 && (
            <>
              {result.saved.length > 0 ? ' ' : ''}
              {result.duplicates.length} record(s) rejected — attendance was already
              recorded for those students today.
            </>
          )}
          {result.failed.length > 0 && <> {result.failed.length} record(s) failed to save.</>}
        </div>
      )}

      {allRecorded && !result && (
        <div className="notice notice--ok" role="status">
          Attendance is complete for today. Each student can only be recorded once per day.
        </div>
      )}

      {!allRecorded && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
          <button className="btn btn--ghost btn--small" type="button" onClick={markAllPresent}>
            Mark all present
          </button>
        </div>
      )}

      <div className="roll">
        {students.map((student) => {
          const locked = student.studentId in recorded;
          const value = locked ? recorded[student.studentId] : draft[student.studentId];

          return (
            <div key={student.studentId} className={`roll__row${locked ? ' roll__row--recorded' : ''}`}>
              <div className="roll__who">
                <span className="roll__name">{student.fullName}</span>
                <span className="roll__adm">{student.admissionNo}</span>
              </div>

              {locked ? (
                <div className="roll__choices">
                  <span className={`pill pill--${value}`}>{LABELS[value]}</span>
                  <span className="roll__locked">recorded</span>
                </div>
              ) : (
                <div className="roll__choices" role="group" aria-label={`Attendance for ${student.fullName}`}>
                  {ATTENDANCE_STATUSES.map((status) => (
                    <button
                      key={status}
                      type="button"
                      className="choice"
                      data-status={status}
                      aria-pressed={value === status}
                      onClick={() => choose(student.studentId, status)}
                      disabled={saving}
                    >
                      {LABELS[status]}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!allRecorded ? (
        <div className="submitbar">
          <button
            className="btn"
            type="button"
            onClick={handleSubmit}
            disabled={saving || unmarked.length > 0}
          >
            {saving
              ? 'Saving…'
              : unmarked.length > 0
                ? `${unmarked.length} student(s) still unmarked`
                : `Submit attendance (${pending.length})`}
          </button>
        </div>
      ) : (
        import.meta.env.DEV && (
          <div className="submitbar">
            <button className="btn btn--ghost" type="button" onClick={replayForDuplicateCheck} disabled={saving}>
              Re-submit today's roll call (duplicate check)
            </button>
          </div>
        )
      )}
    </section>
  );
}
