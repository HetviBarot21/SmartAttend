import { useEffect, useMemo, useState } from 'react';
import { getStudentsByClass, getClassHistory } from '../db/database';
import {
  buildWeeklyHeatmap,
  startOfWeek,
  HEATMAP_LEGEND,
} from '../lib/heatmap';
import { toISO } from '../lib/riskModel';

const LOW_RATE = 0.85;

function weekOptions(count = 6) {
  const thisMonday = startOfWeek(toISO(new Date()));
  const opts = [];
  for (let i = 0; i < count; i += 1) {
    const [y, m, d] = thisMonday.split('-').map(Number);
    const dt = new Date(y, m - 1, d - i * 7);
    const iso = toISO(dt);
    const label =
      i === 0 ? 'This week' : i === 1 ? 'Last week' : `Week of ${dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
    opts.push({ iso, label });
  }
  return opts;
}

export default function Heatmap({ classGroupId }) {
  const options = useMemo(() => weekOptions(), []);
  const [weekStart, setWeekStart] = useState(options[0].iso);
  const [students, setStudents] = useState([]);
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [roll, history] = await Promise.all([
        getStudentsByClass(classGroupId),
        getClassHistory(classGroupId, weekStart),
      ]);
      if (cancelled) return;
      setStudents(roll);
      setRecords(history);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [classGroupId, weekStart]);

  const { days, rows, classAverage } = useMemo(
    () => buildWeeklyHeatmap(students, records, weekStart),
    [students, records, weekStart]
  );

  return (
    <>
      <div className="toolbar">
        <span className="toolbar__label">Overview</span>
        <select
          className="select"
          value={weekStart}
          onChange={(e) => setWeekStart(e.target.value)}
          aria-label="Week"
        >
          {options.map((o) => (
            <option key={o.iso} value={o.iso}>{o.label}</option>
          ))}
        </select>
      </div>

      <div className="legend">
        {HEATMAP_LEGEND.map((l) => (
          <span key={l.key} className="legend__item">
            <span className={`legend__swatch legend__swatch--${l.key}`} />
            {l.label}
          </span>
        ))}
      </div>

      <div className="card">
        {loading ? (
          <p className="empty" style={{ padding: '20px 0' }}>Loading…</p>
        ) : rows.length === 0 ? (
          <p className="empty" style={{ padding: '20px 0' }}>No students in this class yet.</p>
        ) : (
          <div className="heatmap-wrap">
            <table className="heatmap">
              <thead>
                <tr>
                  <th>Student</th>
                  {days.map((d) => (
                    <th key={d.date}>{d.label[0]}</th>
                  ))}
                  <th>%</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ student, cells, rate }) => (
                  <tr key={student.studentId}>
                    <td>{student.fullName}</td>
                    {cells.map((c) => (
                      <td key={c.date}>
                        <span
                          className={`heat-cell${c.status === 'upcoming' ? '' : ` heat-cell--${c.status}`}`}
                          title={`${c.label}: ${c.status}`}
                        />
                      </td>
                    ))}
                    <td className={rate != null && rate < LOW_RATE ? 'rate--low' : undefined}>
                      {rate == null ? '—' : `${Math.round(rate * 100)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2 className="card__title">Class performance</h2>
        <p className="card__hint">Attendance across the selected week</p>
        <div className="bigstat">
          <span className="bigstat__label">Weekly average</span>
          <span className={`bigstat__value${classAverage != null && classAverage < LOW_RATE ? ' rate--low' : ''}`}>
            {classAverage == null ? '—' : `${(classAverage * 100).toFixed(1)}%`}
          </span>
        </div>
        <div className="bar">
          <div className="bar__fill" style={{ width: `${(classAverage ?? 0) * 100}%` }} />
        </div>
      </div>
    </>
  );
}
