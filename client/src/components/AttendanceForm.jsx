import { useCallback, useEffect, useMemo, useState } from 'react';
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
import Avatar from './Avatar';
import { SyncIcon, CheckCircleIcon } from './icons';

const STATUSES = [
  { code: 'present', short: 'P' },
  { code: 'absent', short: 'A' },
  { code: 'late', short: 'L' },
];

const REASONS = [
  { code: 'fee', label: 'Fees' },
  { code: 'health', label: 'Sick' },
  { code: 'other', label: 'Other' },
  { code: 'unknown', label: "Don't know" },
];

const timeOf = (iso) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

export default function AttendanceForm({ classGroupId, pending = 0, onRecordsChanged, onOpenProfile }) {
  const { user } = useAuth();
  const date = todayISO();

  const [students, setStudents] = useState([]);
  // studentId -> the saved Dexie record for today
  const [saved, setSaved] = useState({});
  const [draft, setDraft] = useState({});
  const [reasonDraft, setReasonDraft] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  // null while the first gate check is in flight
  const [gate, setGate] = useState(null);
  const [checkingGate, setCheckingGate] = useState(false);
  const [conflicts, setConflicts] = useState([]);

  const readLocal = useCallback(async () => {
    const [roll, todays] = await Promise.all([
      getStudentsByClass(classGroupId),
      getAttendanceForDate(classGroupId, date),
    ]);
    setStudents(roll);
    setSaved(Object.fromEntries(todays.map((r) => [r.studentId, r])));
    setLoading(false);
  }, [classGroupId, date]);

  // Pull what the gate has recorded, merge it, then re-read. Unsaved taps are
  // kept - a gate refresh must never wipe what the teacher is doing.
  const refreshGate = useCallback(async () => {
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
  }, [classGroupId, date, readLocal, onRecordsChanged]);

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

  // The status a row currently shows: an unsaved edit if there is one, else the
  // saved value.
  const valueFor = useCallback(
    (studentId) => (studentId in draft ? draft[studentId] : recorded[studentId]),
    [draft, recorded],
  );
  const savedReason = useCallback((studentId) => saved[studentId]?.reason ?? null, [saved]);
  const reasonFor = useCallback(
    (studentId) => (studentId in reasonDraft ? reasonDraft[studentId] : savedReason(studentId)),
    [reasonDraft, savedReason],
  );

  // Rows whose shown status or absence reason differs from what's saved -
  // these get written on submit.
  const dirty = useMemo(
    () => students.filter((s) => {
      const status = valueFor(s.studentId);
      if (!status) return false;
      if (status !== recorded[s.studentId]) return true;
      return status === 'absent' && reasonFor(s.studentId) !== savedReason(s.studentId);
    }),
    [students, valueFor, recorded, reasonFor, savedReason],
  );
  const newCount = dirty.filter((s) => !(s.studentId in recorded)).length;
  const editCount = dirty.length - newCount;

  const markedCount = students.filter((s) => valueFor(s.studentId)).length;
  const total = students.length;
  const pct = total === 0 ? 0 : Math.round((markedCount / total) * 100);

  const isGateRecord = (studentId) => GATE_CAPTURE_METHODS.includes(saved[studentId]?.captureMethod);
  const atGateCount = students.filter((s) => isGateRecord(s.studentId)).length;
  const gateActive = gate?.status === 'active';

  const valueForRaw = (draftMap, studentId) =>
    (studentId in draftMap ? draftMap[studentId] : recorded[studentId]);

  function choose(studentId, status) {
    setResult(null);
    setDraft((prev) => {
      const next = { ...prev };
      const savedStatus = recorded[studentId];
      if (valueForRaw(prev, studentId) === status) {
        // tapping the shown status again cancels the pending change
        if (savedStatus === undefined) delete next[studentId];
        else next[studentId] = savedStatus;
      } else {
        next[studentId] = status;
      }
      return next;
    });
  }

  function chooseReason(studentId, code) {
    setResult(null);
    setReasonDraft((prev) => ({ ...prev, [studentId]: reasonFor(studentId) === code ? null : code }));
  }

  // With the gate running, whoever is still unmarked did not scan in - so the
  // shortcut marks them absent (then the teacher adds reasons). Without the
  // gate it is the classic "everyone else is here".
  const fillStatus = gateActive ? 'absent' : 'present';
  function markRemaining() {
    setResult(null);
    setDraft((prev) => {
      const next = { ...prev };
      for (const s of students) {
        if (!valueForRaw(next, s.studentId)) next[s.studentId] = fillStatus;
      }
      return next;
    });
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

      if (events.length === 0) { setSaving(false); return; }

      const outcome = await setAttendanceBatch(events);
      setResult(outcome);
      setDraft({});
      setReasonDraft({});
      await readLocal();
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
  const nameOf = (studentId) => students.find((s) => s.studentId === studentId)?.fullName ?? studentId;

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

      <GateBanner
        gate={gate}
        checking={checkingGate}
        atGateCount={atGateCount}
        total={total}
        onRefresh={refreshGate}
      />

      {conflicts.length > 0 && (
        <div className="notice notice--warn" role="alert">
          {conflicts.map((c) => (
            <div key={c.studentId}>
              {nameOf(c.studentId)} {GATE_CAPTURE_METHODS.includes(c.captureMethod)
                ? `scanned in at the gate at ${timeOf(c.createdAt)}`
                : `was already marked ${c.serverStatus} on the school system`}
              {' '}- your "{c.localStatus}" mark was replaced.
            </div>
          ))}
          <button type="button" className="btn btn--ghost btn--sm gate-banner__action" onClick={() => setConflicts([])}>
            OK
          </button>
        </div>
      )}

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
          Everyone is marked. Tap a status to correct it anytime today.
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={markRemaining}
          disabled={allMarked && dirty.length === 0}
        >
          Mark rest {fillStatus}
        </button>
      </div>

      <div className="roll">
        {students.map((student) => {
          const id = student.studentId;
          const value = valueFor(id);
          const isEdit = dirty.some((s) => s.studentId === id);
          const record = saved[id];
          const fromGate = isGateRecord(id) && !(id in draft && draft[id] !== recorded[id]);
          const showReasons = value === 'absent';
          return (
            <div
              key={id}
              className={`roll-row${showReasons ? ' roll-row--stack' : ''}${value ? ' roll-row--marked' : ''}${isEdit ? ' roll-row--edited' : ''}`}
            >
              <div className={showReasons ? 'roll-row__main' : 'roll-row__contents'}>
                <Avatar name={student.fullName} size="sm" />
                <button
                  type="button"
                  className="roll-row__who"
                  onClick={() => onOpenProfile?.(id)}
                >
                  <span className="roll-row__name">{student.fullName}</span>
                  <span className="roll-row__id">
                    ID: {student.admissionNo || '—'}
                    {fromGate
                      ? ` · at gate ${timeOf(record.createdAt)}${record.captureMethod === 'fingerprint' ? ' (fingerprint)' : ''}`
                      : id in recorded ? ` · saved: ${recorded[id]}` : gateActive ? ' · not scanned' : ''}
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
                      onClick={() => choose(id, code)}
                      disabled={saving}
                    >
                      {short}
                    </button>
                  ))}
                </div>
              </div>

              {showReasons && (
                <div className="reasons" role="group" aria-label={`Why was ${student.fullName} absent?`}>
                  {REASONS.map(({ code, label }) => (
                    <button
                      key={code}
                      type="button"
                      className="reasons__chip"
                      aria-pressed={reasonFor(id) === code}
                      onClick={() => chooseReason(id, code)}
                      disabled={saving}
                    >
                      {label}
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
          disabled={saving || dirty.length === 0}
        >
          <CheckCircleIcon size={18} />
          {saving
            ? 'Saving…'
            : dirty.length > 0
              ? `${gateActive ? 'Confirm' : 'Save'}${editCount ? ' changes' : ''} (${dirty.length})`
              : gateActive ? 'Confirm Attendance' : 'Save Attendance'}
        </button>
      </div>
    </>
  );
}

/** What the gate knows - or why the teacher is on a full manual roll call. */
function GateBanner({ gate, checking, atGateCount, total, onRefresh }) {
  if (!gate) {
    return <div className="notice notice--info" role="status">Checking the school gate…</div>;
  }

  const copy = {
    active: {
      tone: 'ok',
      text: `${atGateCount} of ${total} scanned in at the gate (last scan ${timeOf(gate.lastScanAt)}). Only mark the rest.`,
    },
    'no-scans': {
      tone: 'warn',
      text: 'No gate scans yet today. If students have arrived, the gate may be down - take a full roll call.',
    },
    unreachable: {
      tone: 'warn',
      text: "Can't reach the school gate - take a full roll call. Marks save on this phone and sync later.",
    },
    'unknown-class': {
      tone: 'info',
      text: "This class isn't on the school gate yet - take the roll call as usual.",
    },
  }[gate.status];

  return (
    <div className={`notice notice--${copy.tone} gate-banner`} role="status">
      <span>{copy.text}</span>
      <button
        type="button"
        className="btn btn--ghost btn--sm gate-banner__action"
        onClick={onRefresh}
        disabled={checking}
      >
        {checking ? 'Checking…' : 'Refresh'}
      </button>
    </div>
  );
}
