import { useCallback, useEffect, useState } from 'react';
import { AuthProvider, useAuth, AUTH_STATUS } from './auth/AuthContext';
import LoginScreen from './components/LoginScreen';
import PinUnlock from './components/PinUnlock';
import PinSetup from './components/PinSetup';
import AttendanceForm from './components/AttendanceForm';
import Dashboard from './components/Dashboard';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { countPendingSync } from './db/database';
import { DEMO_CLASS, DEMO_CLASS_ID } from './db/seedData';

const TABS = [
  { id: 'roll', label: 'Roll call' },
  { id: 'dashboard', label: 'Dashboard' }
];

function TeacherApp() {
  const { user, session, signOut, simulateExpiry } = useAuth();
  const online = useOnlineStatus();

  const [tab, setTab] = useState('roll');
  const [refreshKey, setRefreshKey] = useState(0);
  const [pending, setPending] = useState(0);

  const refreshPending = useCallback(async () => {
    setPending(await countPendingSync());
  }, []);

  useEffect(() => { refreshPending(); }, [refreshPending, refreshKey]);

  const handleRecordsChanged = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__title-row">
          <div>
            <h1 className="app__title">SmartAttend AI</h1>
            <p className="app__subtitle">
              {DEMO_CLASS.grade} {DEMO_CLASS.stream} · {user?.displayName}
            </p>
          </div>
          <button className="app__user" type="button" onClick={signOut}>Sign out</button>
        </div>

        <div className="app__badges">
          <span className={`badge ${online ? 'badge--online' : 'badge--offline'}`}>
            {online ? 'Online' : 'Offline — saving to this device'}
          </span>
          {pending > 0 && (
            <span className="badge badge--sync">{pending} record(s) awaiting sync</span>
          )}
          {session?.pinVerified && (
            <span className="badge badge--warn">PIN session</span>
          )}
        </div>
      </header>

      <nav className="tabs" role="tablist" aria-label="Views">
        {TABS.map((t) => (
          <button
            key={t.id}
            className="tabs__tab"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="app__main">
        {tab === 'roll' ? (
          <AttendanceForm classGroupId={DEMO_CLASS_ID} onRecordsChanged={handleRecordsChanged} />
        ) : (
          <Dashboard classGroupId={DEMO_CLASS_ID} refreshKey={refreshKey} />
        )}

        {import.meta.env.DEV && (
          <div className="devnote">
            <strong>Demo controls.</strong>{' '}
            <button className="linkbtn" type="button" onClick={simulateExpiry}>
              Simulate session expiry
            </button>{' '}
            — expires the token so the offline PIN unlock screen appears.
          </div>
        )}
      </main>
    </div>
  );
}

function AuthGate() {
  const { status, pinState } = useAuth();
  const [pinSetupSkipped, setPinSetupSkipped] = useState(false);

  if (status === AUTH_STATUS.LOADING) return <div className="centered">Loading SmartAttend…</div>;
  if (status === AUTH_STATUS.SIGNED_OUT) return <LoginScreen />;
  if (status === AUTH_STATUS.LOCKED) return <PinUnlock />;

  // Offered once per sign-in. Skipping is allowed but leaves the teacher unable
  // to recover an expired session while offline, which PinUnlock explains.
  if (!pinState.enrolled && !pinSetupSkipped) {
    return <PinSetup onDone={() => setPinSetupSkipped(true)} onSkip={() => setPinSetupSkipped(true)} />;
  }

  return <TeacherApp />;
}

export default function App() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}
