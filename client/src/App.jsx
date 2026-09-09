import { useCallback, useEffect, useState } from 'react';
import { AuthProvider, useAuth, AUTH_STATUS } from './auth/AuthContext';
import LoginScreen from './components/LoginScreen';
import PinUnlock from './components/PinUnlock';
import PinSetup from './components/PinSetup';
import AttendanceForm from './components/AttendanceForm';
import Heatmap from './components/Heatmap';
import Alerts from './components/Alerts';
import StudentProfile from './components/StudentProfile';
import BottomNav from './components/BottomNav';
import TopBar from './components/TopBar';
import AccountSheet from './components/AccountSheet';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { countPendingSync } from './db/database';
import { requestBackgroundSync } from './services/syncService';
import { DEMO_CLASS, DEMO_CLASS_ID } from './db/seedData';

const CLASS_NAME = `${DEMO_CLASS.grade}${DEMO_CLASS.stream}`; // "Form 3B"
const TITLES = { attendance: CLASS_NAME, heatmap: 'Heatmap', alerts: 'Alerts' };

function TeacherApp() {
  const { user, session, pinState, signOut, simulateExpiry } = useAuth();
  const online = useOnlineStatus();

  const [tab, setTab] = useState('attendance');
  const [profileId, setProfileId] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [pending, setPending] = useState(0);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pinSetupOpen, setPinSetupOpen] = useState(false);

  const refreshPending = useCallback(async () => {
    setPending(await countPendingSync());
  }, []);

  useEffect(() => { refreshPending(); }, [refreshPending, refreshKey]);

  const handleRecordsChanged = useCallback(() => {
    setRefreshKey((k) => k + 1);
    requestBackgroundSync().catch(() => {});
  }, []);

  const openProfile = useCallback((id) => {
    setProfileId(id);
    window.scrollTo(0, 0);
  }, []);

  const goTab = useCallback((next) => {
    setProfileId(null);
    setTab(next);
    window.scrollTo(0, 0);
  }, []);

  const account = (
    <TopBar
      title={profileId ? 'Profile' : TITLES[tab]}
      onBack={profileId ? () => setProfileId(null) : undefined}
      online={online}
      onAccount={() => setSheetOpen(true)}
    />
  );

  let body;
  if (profileId) {
    body = <StudentProfile studentId={profileId} className={CLASS_NAME} />;
  } else if (tab === 'heatmap') {
    body = <Heatmap classGroupId={DEMO_CLASS_ID} />;
  } else if (tab === 'alerts') {
    body = <Alerts classGroupId={DEMO_CLASS_ID} className={CLASS_NAME} onOpenProfile={openProfile} />;
  } else {
    body = (
      <AttendanceForm
        classGroupId={DEMO_CLASS_ID}
        pending={pending}
        onRecordsChanged={handleRecordsChanged}
        onOpenProfile={openProfile}
      />
    );
  }

  if (pinSetupOpen) {
    return (
      <PinSetup
        changing={pinState.enrolled}
        skipLabel="Cancel"
        onDone={() => setPinSetupOpen(false)}
        onSkip={() => setPinSetupOpen(false)}
      />
    );
  }

  return (
    <div className="app">
      {account}
      <div className="app__scroll">{body}</div>

      {!profileId && <BottomNav active={tab} onChange={goTab} />}

      {sheetOpen && (
        <AccountSheet
          user={user}
          online={online}
          pending={pending}
          pinSession={Boolean(session?.pinVerified)}
          pinEnrolled={pinState.enrolled}
          onManagePin={() => { setSheetOpen(false); setPinSetupOpen(true); }}
          onSignOut={() => { setSheetOpen(false); signOut(); }}
          onSimulateExpiry={
            import.meta.env.DEV
              ? () => { setSheetOpen(false); simulateExpiry(); }
              : undefined
          }
          onClose={() => setSheetOpen(false)}
        />
      )}
    </div>
  );
}

function AuthGate() {
  const { status, pinState } = useAuth();
  const [pinSetupSkipped, setPinSetupSkipped] = useState(false);

  if (status === AUTH_STATUS.LOADING) return <div className="centered">Loading SmartAttend…</div>;
  if (status === AUTH_STATUS.SIGNED_OUT) return <LoginScreen />;
  if (status === AUTH_STATUS.LOCKED) return <PinUnlock />;

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
