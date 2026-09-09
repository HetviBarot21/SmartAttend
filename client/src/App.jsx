import { useCallback, useEffect, useState } from 'react';
import { AuthProvider, useAuth, AUTH_STATUS } from './auth/AuthContext';
import LoginScreen from './components/LoginScreen';
import PinUnlock from './components/PinUnlock';
import PinSetup from './components/PinSetup';
import RosterManager from './components/RosterManager';
import SetupWizard from './components/SetupWizard';
import ClassSwitcher from './components/ClassSwitcher';
import AttendanceForm from './components/AttendanceForm';
import Heatmap from './components/Heatmap';
import Alerts from './components/Alerts';
import StudentProfile from './components/StudentProfile';
import BottomNav from './components/BottomNav';
import TopBar from './components/TopBar';
import AccountSheet from './components/AccountSheet';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { countPendingSync, getClasses, classLabel } from './db/database';
import { requestBackgroundSync } from './services/syncService';

const STATIC_TITLES = { heatmap: 'Heatmap', alerts: 'Alerts' };

const ACTIVE_CLASS_KEY = 'smartattend:activeClass';
const readActiveClass = () => {
  try { return localStorage.getItem(ACTIVE_CLASS_KEY); } catch { return null; }
};
const writeActiveClass = (id) => {
  try { localStorage.setItem(ACTIVE_CLASS_KEY, id); } catch { /* private mode */ }
};

function TeacherApp() {
  const { user, session, pinState, signOut, simulateExpiry } = useAuth();
  const online = useOnlineStatus();

  const [tab, setTab] = useState('attendance');
  const [profileId, setProfileId] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [pending, setPending] = useState(0);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pinSetupOpen, setPinSetupOpen] = useState(false);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  const [classes, setClasses] = useState(null); // null = still loading
  const [activeClassId, setActiveClassId] = useState(null);

  const loadClasses = useCallback(async () => {
    const list = await getClasses();
    setClasses(list);
    setActiveClassId((current) => {
      const stored = current ?? readActiveClass();
      const stillValid = list.some((c) => c.classGroupId === stored);
      return stillValid ? stored : (list[0]?.classGroupId ?? null);
    });
  }, []);

  useEffect(() => { loadClasses(); }, [loadClasses, refreshKey]);

  const refreshPending = useCallback(async () => {
    setPending(await countPendingSync());
  }, []);
  useEffect(() => { refreshPending(); }, [refreshPending, refreshKey]);

  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);

  const handleRecordsChanged = useCallback(() => {
    bump();
    requestBackgroundSync().catch(() => {});
  }, [bump]);

  const openProfile = useCallback((id) => { setProfileId(id); window.scrollTo(0, 0); }, []);
  const goTab = useCallback((next) => {
    setProfileId(null);
    setTab(next);
    window.scrollTo(0, 0);
  }, []);

  const pickClass = useCallback((id) => {
    setActiveClassId(id);
    writeActiveClass(id);
    setSwitcherOpen(false);
    setProfileId(null);
    bump();
  }, [bump]);

  // ----- gates that replace the whole screen ----------------------------- //

  if (classes === null) return <div className="centered">Loading classes…</div>;

  if (classes.length === 0) {
    return <SetupWizard onDone={(id) => { writeActiveClass(id); bump(); }} />;
  }

  const activeClass = classes.find((c) => c.classGroupId === activeClassId) ?? classes[0];
  const activeLabel = classLabel(activeClass);

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

  if (rosterOpen) {
    return (
      <RosterManager
        classGroupId={activeClassId}
        className={classLabel(activeClass)}
        onClose={() => { setRosterOpen(false); bump(); }}
      />
    );
  }

  if (profileId) {
    return (
      <StudentProfile
        studentId={profileId}
        className={activeLabel}
        onBack={() => setProfileId(null)}
      />
    );
  }

  let body;
  if (tab === 'heatmap') {
    body = <Heatmap key={activeClassId} classGroupId={activeClassId} />;
  } else if (tab === 'alerts') {
    body = <Alerts key={activeClassId} classGroupId={activeClassId} className={activeLabel} onOpenProfile={openProfile} />;
  } else {
    body = (
      <AttendanceForm
        key={activeClassId}
        classGroupId={activeClassId}
        pending={pending}
        onRecordsChanged={handleRecordsChanged}
        onOpenProfile={openProfile}
      />
    );
  }

  return (
    <div className="app">
      <TopBar
        title={tab === 'attendance' ? activeLabel : STATIC_TITLES[tab]}
        onTitleClick={tab === 'attendance' ? () => setSwitcherOpen(true) : undefined}
        online={online}
        onAccount={() => setSheetOpen(true)}
      />
      <div className="app__scroll">{body}</div>

      <BottomNav active={tab} onChange={goTab} />

      {switcherOpen && (
        <ClassSwitcher
          activeClassId={activeClassId}
          onPick={pickClass}
          onManageRoster={() => { setSwitcherOpen(false); setRosterOpen(true); }}
          onClose={() => setSwitcherOpen(false)}
        />
      )}

      {sheetOpen && (
        <AccountSheet
          user={user}
          online={online}
          pending={pending}
          pinSession={Boolean(session?.pinVerified)}
          pinEnrolled={pinState.enrolled}
          onManagePin={() => { setSheetOpen(false); setPinSetupOpen(true); }}
          onManageRoster={() => { setSheetOpen(false); setRosterOpen(true); }}
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
