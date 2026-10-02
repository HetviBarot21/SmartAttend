import { useEffect, useMemo, useState } from 'react';
import { getStudentsByClass, getClassHistory } from '../db/database';
import {
  buildRegisterGrid,
  startOfWeek,
  monthBounds,
  schoolDaysInRange,
} from '../lib/heatmap';
import { toISO } from '../lib/riskModel';
import { ChevronLeftIcon, ChevronRightIcon } from './icons';
import { showToast } from '../lib/toast';

const LOW_RATE = 0.85;
const CODE = { present: 'P', late: 'L', absent: 'A', upcoming: '' };
const STATUS_TEXT = { present: 'Present', late: 'Late', absent: 'Absent', upcoming: 'Not yet taken' };

function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function shift(iso, { days = 0, months = 0 }) {
  const dt = parseISO(iso);
  if (months) dt.setMonth(dt.getMonth() + months, 1);
  dt.setDate(dt.getDate() + days);
  return toISO(dt);
}

function periodFor(mode, anchor) {
  if (mode === 'month') {
    const { start, end } = monthBounds(anchor);
    const label = parseISO(start).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    return { start, end, label };
  }
  const start = startOfWeek(anchor);
  const end = shift(start, { days: 4 });
  const fmt = (iso, opts) => parseISO(iso).toLocaleDateString('en-GB', opts);
  return { start, end, label: `${fmt(start, { day: 'numeric', month: 'short' })} - ${fmt(end, { day: 'numeric', month: 'short', year: 'numeric' })}` };
}

function downloadCsv(filename, days, rows) {
  const head = ['Student', 'Adm. No.', ...days.map((d) => d.date), 'Present', 'Late', 'Absent', 'Rate'];
  const lines = rows.map(({ student, cells, totals, rate }) => [
    student.fullName,
    student.admissionNo ?? '',
    ...cells.map((c) => CODE[c.status]),
    totals.present,
    totals.late,
    totals.absent,
    rate == null ? '' : `${Math.round(rate * 100)}%`,
  ]);
  const csv = [head, ...lines]
    .map((cols) => cols.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`Downloaded ${filename}`);
}

/** Attendance register report: students down the side, school days across. */
export default function Heatmap({ classGroupId, className }) {
  const today = toISO(new Date());
  const [mode, setMode] = useState('week');
  const [anchor, setAnchor] = useState(today);
  const [students, setStudents] = useState([]);
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);

  const period = useMemo(() => periodFor(mode, anchor), [mode, anchor]);
  const atLatest = period.end >= today;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [roll, history] = await Promise.all([
        getStudentsByClass(classGroupId),
        getClassHistory(classGroupId, period.start),
      ]);
      if (cancelled) return;
      setStudents(roll);
      setRecords(history.filter((r) => r.date <= period.end));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [classGroupId, period.start, period.end]);

  const { days, rows, classAverage } = useMemo(
    () => buildRegisterGrid(students, records, schoolDaysInRange(period.start, period.end), today),
    [students, records, period.start, period.end, today],
  );

  const takenDays = days.filter((d) => d.date < today || (d.date === today && records.some((r) => r.date === today))).length;
  const absences = rows.reduce((n, r) => n + r.totals.absent, 0);
  const lates = rows.reduce((n, r) => n + r.totals.late, 0);
  const below = rows.filter((r) => r.rate != null && r.rate < LOW_RATE).length;

  function step(dir) {
    setAnchor((a) => (mode === 'month' ? shift(a, { months: dir }) : shift(startOfWeek(a), { days: 7 * dir })));
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">Attendance report</h2>
          <p className="page-head__sub">{className ? `${className} · ` : ''}register by school day</p>
        </div>
        <div className="page-head__actions">
          <div className="segmented" role="tablist" aria-label="Report period">
            {['week', 'month'].map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                onClick={() => setMode(m)}
              >
                {m === 'week' ? 'Week' : 'Month'}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn--outline btn--sm"
            onClick={() => downloadCsv(`attendance-${period.start}-to-${period.end}.csv`, days, rows)}
            disabled={loading || rows.length === 0}
          >
            Export CSV
          </button>
        </div>
      </div>

      <div className="stat-strip">
        <div>
          <span className="stat-strip__label">Class average</span>
          <span className="stat-strip__value">{classAverage == null ? '-' : `${(classAverage * 100).toFixed(1)}%`}</span>
        </div>
        <div>
          <span className="stat-strip__label">Days recorded</span>
          <span className="stat-strip__value">{takenDays} <small>of {days.length}</small></span>
        </div>
        <div>
          <span className="stat-strip__label">Absences</span>
          <span className="stat-strip__value">{absences}</span>
        </div>
        <div>
          <span className="stat-strip__label">Late arrivals</span>
          <span className="stat-strip__value">{lates}</span>
        </div>
        <div>
          <span className="stat-strip__label">Below {Math.round(LOW_RATE * 100)}%</span>
          <span className="stat-strip__value">{below} <small>of {rows.length}</small></span>
        </div>
      </div>

      <div className="panel">
        <div className="panel__toolbar">
          <div className="period-nav">
            <button type="button" className="icon-btn" onClick={() => step(-1)} aria-label="Previous period">
              <ChevronLeftIcon size={16} />
            </button>
            <span className="period-nav__label">{period.label}</span>
            <button type="button" className="icon-btn" onClick={() => step(1)} disabled={atLatest} aria-label="Next period">
              <ChevronRightIcon size={16} />
            </button>
            {!atLatest && (
              <button type="button" className="linkbtn" onClick={() => setAnchor(today)}>
                {mode === 'week' ? 'This week' : 'This month'}
              </button>
            )}
          </div>
          <div className="reg-legend">
            <span><span className="reg-code reg-code--present">P</span>Present</span>
            <span><span className="reg-code reg-code--late">L</span>Late</span>
            <span><span className="reg-code reg-code--absent">A</span>Absent</span>
            <span><span className="reg-code reg-code--upcoming">-</span>Not taken</span>
          </div>
        </div>

        {loading ? (
          <p className="empty">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="empty">No students in this class yet.</p>
        ) : (
          <div className="table-wrap">
            <table className={`table reg-table reg-table--${mode}`}>
              <thead>
                <tr>
                  <th className="reg-table__name">Student</th>
                  {days.map((d) => (
                    <th
                      key={d.date}
                      className={`reg-table__day${d.date === today ? ' is-today' : ''}`}
                      title={parseISO(d.date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
                    >
                      <span>{mode === 'month' ? d.label[0] : d.label}</span>
                      <b>{Number(d.date.slice(8, 10))}</b>
                    </th>
                  ))}
                  <th className="reg-table__num">P</th>
                  <th className="reg-table__num">L</th>
                  <th className="reg-table__num">A</th>
                  <th className="reg-table__rate">Attendance</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ student, cells, rate, totals }) => {
                  const low = rate != null && rate < LOW_RATE;
                  return (
                    <tr key={student.studentId}>
                      <td className="reg-table__name">
                        <span className="reg-table__student">{student.fullName}</span>
                        <span className="reg-table__adm">{student.admissionNo || '-'}</span>
                      </td>
                      {cells.map((c) => (
                        <td
                          key={c.date}
                          className={`reg-table__day${c.date === today ? ' is-today' : ''}`}
                          title={`${student.fullName}, ${c.date}: ${STATUS_TEXT[c.status]}`}
                        >
                          <span className={`reg-code reg-code--${c.status}`}>{CODE[c.status] || '-'}</span>
                        </td>
                      ))}
                      <td className="reg-table__num">{totals.present}</td>
                      <td className="reg-table__num">{totals.late}</td>
                      <td className={`reg-table__num${totals.absent ? ' is-absent' : ''}`}>{totals.absent}</td>
                      <td className="reg-table__rate">
                        <span className={`reg-rate${low ? ' reg-rate--low' : ''}`}>
                          <span className="reg-rate__value">{rate == null ? '-' : `${Math.round(rate * 100)}%`}</span>
                          <span className="reg-rate__track">
                            <span className="reg-rate__fill" style={{ width: `${(rate ?? 0) * 100}%` }} />
                          </span>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="footnote">
        P present, L late (counts as attended), A absent. A past school day with no record counts as absent.
        Attendance below {Math.round(LOW_RATE * 100)}% is marked.
      </p>
    </>
  );
}
