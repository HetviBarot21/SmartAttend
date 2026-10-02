import { useCallback, useEffect, useRef, useState } from 'react';
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
import Dashboard from './components/Dashboard';
import StudentProfile from './components/StudentProfile';
import BottomNav from './components/BottomNav';
import SideNav from './components/SideNav';
import AdminOverview from './components/AdminOverview';
import AdminClassDetail from './components/AdminClassDetail';
import SystemAdminOverview from './components/SystemAdminOverview';
import TopBar from './components/TopBar';
import AccountSheet from './components/AccountSheet';
import Toaster from './components/Toaster';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { useHashRoute } from './hooks/useHashRoute';
import {
  countPendingSync, getClasses, classLabel, getStudentById, getStudentsByClass, getAttendanceForDate, todayISO,
} from './db/database';
import { isSchoolDay } from './lib/riskModel';
import { requestBackgroundSync } from './services/syncService';

const TITLES = {
  dashboard: 'Dashboard',
  attendance: 'Take Attendance',
  heatmap: 'Reports',
  alerts: 'At-risk Students',
  students: 'Students',
  overview: 'School Overview',
};

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
  const [route, navigate] = useHashRoute();

  const [refreshKey, setRefreshKey] = useState(0);
  const [pending, setPending] = useState(0);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pinSetupOpen, setPinSetupOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [studentNames, setStudentNames] = useState({});
  const [registerStatus, setRegisterStatus] = useState(null); // 'done' | 'due' | null
  const registerDirty = useRef(false);
  const setRegisterDirty = useCallback((dirty) => { registerDirty.current = dirty; }, []);
  const role = user?.role ?? 'teacher';

  const [classes, setClasses] = useState(null); // null = still loading
  const [activeClassId, setActiveClassId] = useState(null);

  const loadClasses = useCallback(async () => {
    const list = await getClasses({ ownerUsername: user?.username });
    setClasses(list);
    setActiveClassId((current) => {
      const stored = current ?? readActiveClass();
      const stillValid = list.some((c) => c.classGroupId === stored);
      return stillValid ? stored : (list[0]?.classGroupId ?? null);
    });
  }, [user?.username]);

  useEffect(() => { loadClasses(); }, [loadClasses, refreshKey]);

  const refreshPending = useCallback(async () => {
    setPending(await countPendingSync());
  }, []);
  useEffect(() => { refreshPending(); }, [refreshPending, refreshKey]);

  // Has today's register been taken for the active class? Shown in the menu.
  useEffect(() => {
    if (!activeClassId) return undefined;
    let cancelled = false;
    const today = todayISO();
    Promise.all([getStudentsByClass(activeClassId), getAttendanceForDate(activeClassId, today)]).then(([roll, recs]) => {
      if (cancelled) return;
      const marked = new Set(recs.map((r) => r.studentId));
      const done = roll.length > 0 && roll.every((st) => marked.has(st.studentId));
      setRegisterStatus(done ? 'done' : isSchoolDay(today) && roll.length > 0 ? 'due' : null);
    });
    return () => { cancelled = true; };
  }, [activeClassId, refreshKey]);

  // Name for the breadcrumb on a student page.
  useEffect(() => {
    const id = route.studentId;
    if (!id) return undefined;
    let cancelled = false;
    getStudentById(id).then((s) => {
      if (!cancelled && s) setStudentNames((names) => ({ ...names, [id]: s.fullName }));
    });
    return () => { cancelled = true; };
  }, [route.studentId]);

  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);

  const handleRecordsChanged = useCallback(() => {
    bump();
    requestBackgroundSync().catch(() => {});
  }, [bump]);

  // Admins have no roster page; teachers have no school overview.
  const allowed = (tab) => (tab === 'students' ? role !== 'admin' : tab === 'overview' ? role === 'admin' : true);
  const tab = allowed(route.tab) ? route.tab : 'dashboard';

  // Leaving the register with unsaved ticks asks first.
  const go = useCallback((next, opts) => {
    if (registerDirty.current
      && !window.confirm('You have unsaved attendance changes. Leave this page without saving?')) return false;
    navigate(next, opts);
    return true;
  }, [navigate]);
  const goTab = useCallback((next) => go({ tab: next }), [go]);
  const openProfile = useCallback((id) => go({ tab, studentId: id }), [go, tab]);

  const pickClass = useCallback((id) => {
    setSwitcherOpen(false);
    if (id === activeClassId) return;
    if (registerDirty.current
      && !window.confirm('You have unsaved attendance changes. Switch class without saving?')) return;
    setActiveClassId(id);
    writeActiveClass(id);
    if (route.studentId) navigate({ tab });
    bump();
  }, [activeClassId, bump, navigate, route.studentId, tab]);

  // Full-screen gates

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

  // Breadcrumb: class > section > (student or class detail)
  let detail = null; // set on a student or class page below the section

  let body;
  if (route.studentId) {
    body = (
      <StudentProfile
        key={route.studentId}
        studentId={route.studentId}
        className={activeLabel}
      />
    );
    detail = studentNames[route.studentId] ?? 'Student';
  } else if (tab === 'overview' && route.classId) {
    body = <AdminClassDetail classGroupId={route.classId} />;
    detail = 'Class';
  } else if (tab === 'dashboard') {
    body = (
      <Dashboard
        key={`${activeClassId}-${refreshKey}`}
        classGroupId={activeClassId}
        className={activeLabel}
        onTakeAttendance={() => goTab('attendance')}
        onOpenAlerts={() => goTab('alerts')}
        onOpenProfile={openProfile}
      />
    );
  } else if (tab === 'overview') {
    body = <AdminOverview onOpenClass={(id) => go({ tab: 'overview', classId: id })} />;
  } else if (tab === 'heatmap') {
    body = <Heatmap key={activeClassId} classGroupId={activeClassId} className={activeLabel} />;
  } else if (tab === 'alerts') {
    body = <Alerts key={activeClassId} classGroupId={activeClassId} className={activeLabel} onOpenProfile={openProfile} />;
  } else if (tab === 'students') {
    body = (
      <RosterManager
        key={activeClassId}
        classGroupId={activeClassId}
        className={activeLabel}
      />
    );
  } else {
    body = (
      <AttendanceForm
        key={activeClassId}
        classGroupId={activeClassId}
        pending={pending}
        onRecordsChanged={handleRecordsChanged}
        onOpenProfile={openProfile}
        onDirtyChange={setRegisterDirty}
      />
    );
  }

  // The current page is the last crumb and is not a link.
  const classCrumb = { label: activeLabel, onClick: () => setSwitcherOpen(true), picker: true };
  const crumbs = detail
    ? [classCrumb, { label: TITLES[tab], onClick: () => go({ tab }, { up: true }) }, { label: detail }]
    : [classCrumb, { label: TITLES[tab] }];

  return (
    <div className="shell">
      <SideNav
        active={tab}
        onChange={goTab}
        role={role}
        classLabel={activeLabel}
        onSwitchClass={() => setSwitcherOpen(true)}
        user={user}
        online={online}
        pending={pending}
        registerStatus={registerStatus}
        onAccount={() => setSheetOpen(true)}
      />
      <div className="app">
        <TopBar
          crumbs={crumbs}
          online={online}
          onAccount={() => setSheetOpen(true)}
        />
        <div className="app__scroll">{body}</div>

        <BottomNav active={tab} onChange={goTab} role={role} registerStatus={registerStatus} />
      </div>
      <Toaster />

      {switcherOpen && (
        <ClassSwitcher
          activeClassId={activeClassId}
          onPick={pickClass}
          onManageRoster={() => { setSwitcherOpen(false); goTab('students'); }}
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
          onManageRoster={role !== 'admin' ? () => { setSheetOpen(false); goTab('students'); } : undefined}
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

// "Not now" on the PIN prompt is remembered per user so it does not reappear on every reload.
const pinSkipKey = (user) => `smartattend:pin-skipped:${user?.username ?? ''}`;
const readPinSkipped = (user) => {
  try { return localStorage.getItem(pinSkipKey(user)) === '1'; } catch { return false; }
};

function AuthGate() {
  const { status, pinState, user } = useAuth();
  const [pinSetupSkipped, setPinSetupSkipped] = useState(false);
  const skipPinSetup = () => {
    try { localStorage.setItem(pinSkipKey(user), '1'); } catch { /* private mode */ }
    setPinSetupSkipped(true);
  };

  if (status === AUTH_STATUS.LOADING) return <div className="centered">Loading SmartAttend…</div>;
  if (status === AUTH_STATUS.SIGNED_OUT) return <LoginScreen />;
  if (status === AUTH_STATUS.LOCKED) return <PinUnlock />;

  // System admins skip the PIN and class-setup gates.
  if (user?.role === 'system_admin') return <SystemAdminOverview />;

  if (!pinState.enrolled && !pinSetupSkipped && !readPinSkipped(user)) {
    return <PinSetup onDone={() => setPinSetupSkipped(true)} onSkip={skipPinSetup} />;
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
