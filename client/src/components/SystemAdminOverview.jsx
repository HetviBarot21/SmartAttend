import { useCallback, useEffect, useState } from 'react';
import { getAllSchools, setSchoolStatus } from '../services/systemAdminService';
import { useAuth } from '../auth/AuthContext';
import TopBar from './TopBar';

/**
 * System-admin home: every school, with an activate/deactivate toggle.
 * Deactivating a school does not block its users yet.
 */
export default function SystemAdminOverview() {
  const { signOut } = useAuth();
  const [schools, setSchools] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    try {
      const list = await getAllSchools();
      setSchools(list);
      setError(null);
    } catch (err) {
      setError(err.message ?? 'Could not reach the server');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function toggle(school) {
    const next = school.status === 'active' ? 'inactive' : 'active';
    setBusyId(school.schoolId);
    try {
      await setSchoolStatus(school.schoolId, next);
      await load();
    } catch (err) {
      setError(err.message ?? 'Could not update this school');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="app">
      <TopBar crumbs={[{ label: 'System Admin' }]} />
      <div className="app__scroll">
        <p className="card__hint" style={{ marginTop: 4 }}>
          Every school on the platform. Deactivating a school is a status flag
          for now - it does not yet block sign-in or sync.
        </p>

        {error && <p className="empty">Could not reach the server ({error}).</p>}
        {!error && schools === null && <p className="empty">Loading schools…</p>}

        {schools && (
          <div className="admin-table">
            {schools.map((s) => (
              <div key={s.schoolId} className="admin-table__row" style={{ cursor: 'default' }}>
                <span className="admin-table__name">{s.name}</span>
                <span className="admin-table__meta">{s.county || 'No county on record'}</span>
                <span className="admin-table__meta">
                  {s.classCount} class{s.classCount === 1 ? '' : 'es'} · {s.studentCount} student{s.studentCount === 1 ? '' : 's'}
                </span>
                <span className={`pill pill--${s.status === 'active' ? 'present' : 'absent'}`}>
                  {s.status === 'active' ? 'Active' : 'Inactive'}
                </span>
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  disabled={busyId === s.schoolId}
                  onClick={() => toggle(s)}
                >
                  {busyId === s.schoolId ? 'Saving…' : s.status === 'active' ? 'Deactivate' : 'Activate'}
                </button>
              </div>
            ))}
            {schools.length === 0 && <p className="empty">No schools have reached the server yet.</p>}
          </div>
        )}

        <button type="button" className="btn btn--sm btn--ghost" style={{ marginTop: 16 }} onClick={signOut}>
          Sign out
        </button>
      </div>
    </div>
  );
}
