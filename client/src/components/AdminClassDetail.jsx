import { useCallback, useEffect, useState } from 'react';
import { getClassStudents, getSchoolFlagged } from '../services/adminService';
import { useAuth } from '../auth/AuthContext';
import Avatar from './Avatar';
import TopBar from './TopBar';

const RISK_LABEL = { red: 'RED', amber: 'AMBER' };

/**
 * Read-only drill-down into one class, reached from AdminOverview's class
 * table - what the owning teacher's roster looks like from the school
 * admin's side, plus that class's slice of the school-wide flagged list so
 * the admin doesn't have to cross-reference two screens.
 */
export default function AdminClassDetail({ classGroupId, onBack }) {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [flagged, setFlagged] = useState([]);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [cls, allFlagged] = await Promise.all([
        getClassStudents(classGroupId),
        user?.schoolId ? getSchoolFlagged(user.schoolId) : [],
      ]);
      setData(cls);
      setFlagged(allFlagged.filter((f) => f.classGroupId === classGroupId));
    } catch (err) {
      setError(err.message ?? 'Could not load this class');
    }
  }, [classGroupId, user?.schoolId]);

  useEffect(() => { load(); }, [load]);

  const flagByStudent = new Map(flagged.map((f) => [f.studentId, f]));
  const title = data ? [data.class.grade, data.class.stream].filter(Boolean).join(' ') || 'Class' : 'Class';

  return (
    <div className="app">
      <TopBar title={title} onBack={onBack} />
      <div className="app__scroll">
        {error && <p className="empty">Could not load this class ({error}).</p>}
        {!error && !data && <p className="empty">Loading…</p>}
        {data && (
          <>
            <p className="card__hint" style={{ marginTop: 4 }}>
              Teacher: {data.class.teacherName || 'unassigned'} · {data.students.length} student{data.students.length === 1 ? '' : 's'}
            </p>
            <div className="roll">
              {data.students.map((s) => {
                const flag = flagByStudent.get(s.studentId);
                return (
                  <div key={s.studentId} className="roll-row">
                    <Avatar name={s.fullName} size="sm" />
                    <div className="roll-row__who" style={{ cursor: 'default' }}>
                      <span className="roll-row__name">{s.fullName}</span>
                      <span className="roll-row__id">Adm {s.admissionNo || '—'}</span>
                    </div>
                    {flag && (
                      <span className={`pill pill--risk-${flag.flag === 'red' ? 'red' : 'amber'}`}>
                        {RISK_LABEL[flag.flag]}
                      </span>
                    )}
                  </div>
                );
              })}
              {data.students.length === 0 && (
                <p className="empty">No students have reached the server for this class yet.</p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
