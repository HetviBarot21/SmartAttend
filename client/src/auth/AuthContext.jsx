import { createContext, useContext, useCallback, useEffect, useMemo, useState } from 'react';
import {
  signIn as cognitoSignIn,
  signUp as cognitoSignUp,
  confirmSignUp as cognitoConfirmSignUp,
  resendConfirmationCode as cognitoResendCode,
  signOut as cognitoSignOut,
  loadStoredSession,
  isSessionValid,
  extendSessionWithPin,
  expireSessionNow,
  isCognitoConfigured
} from './cognito';
import { verifyPin, setPin, hasPin, getPinStatus, clearLockout } from './pin';

const AuthContext = createContext(null);

/**
 * Three states, because "signed out" and "session expired while offline" need
 * different screens:
 *   signedOut - no session on the device; password login only.
 *   locked    - a session exists but its token has expired; the teacher can
 *               unlock with their PIN without any network.
 *   ready     - authenticated, attendance capture is available.
 */
export const AUTH_STATUS = { LOADING: 'loading', SIGNED_OUT: 'signedOut', LOCKED: 'locked', READY: 'ready' };

export function AuthProvider({ children }) {
  const [status, setStatus] = useState(AUTH_STATUS.LOADING);
  const [session, setSession] = useState(null);
  const [pinState, setPinState] = useState({ enrolled: false, locked: false, attemptsRemaining: 3 });

  const refreshPinState = useCallback(async (username) => {
    if (!username) return;
    setPinState(await getPinStatus(username));
  }, []);

  const applySession = useCallback(async (next) => {
    setSession(next);
    if (!next) {
      setStatus(AUTH_STATUS.SIGNED_OUT);
      return;
    }
    await refreshPinState(next.username);
    setStatus(isSessionValid(next) ? AUTH_STATUS.READY : AUTH_STATUS.LOCKED);
  }, [refreshPinState]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await loadStoredSession();
      if (cancelled) return;
      if (!stored) {
        setStatus(AUTH_STATUS.SIGNED_OUT);
        return;
      }
      await applySession(stored);
    })();
    return () => { cancelled = true; };
  }, [applySession]);

  const signIn = useCallback(async (username, password) => {
    const next = await cognitoSignIn(username, password);
    // An online login outranks an offline lockout.
    await clearLockout(username);
    await applySession(next);
    return { session: next, pinEnrolled: await hasPin(username) };
  }, [applySession]);

  const signUp = useCallback(async ({ name, email, password, role, schoolName }) => {
    const result = await cognitoSignUp({ name, email, password, role, schoolName });
    await clearLockout(email.trim());
    if (!result.needsConfirmation) await applySession(result.session);
    return result;
  }, [applySession]);

  const confirmSignUp = useCallback(async (username, code, password) => {
    const next = await cognitoConfirmSignUp(username, code, password);
    if (next) await applySession(next);
    return next;
  }, [applySession]);

  const resendConfirmationCode = useCallback(
    (username) => cognitoResendCode(username),
    []
  );

  const unlockWithPin = useCallback(async (pin) => {
    if (!session) throw new Error('No session to unlock');
    try {
      await verifyPin(session.username, pin);
    } catch (err) {
      await refreshPinState(session.username);
      throw err;
    }
    const next = await extendSessionWithPin(session);
    await applySession(next);
    return next;
  }, [session, applySession, refreshPinState]);

  const enrolPin = useCallback(async (pin) => {
    if (!session) throw new Error('No session to attach a PIN to');
    await setPin(session.username, pin);
    await refreshPinState(session.username);
  }, [session, refreshPinState]);

  const signOut = useCallback(async () => {
    await cognitoSignOut();
    setSession(null);
    setPinState({ enrolled: false, locked: false, attemptsRemaining: 3 });
    setStatus(AUTH_STATUS.SIGNED_OUT);
  }, []);

  // Demo affordance for the Sprint 1 presentation - see cognito.expireSessionNow.
  const simulateExpiry = useCallback(async () => {
    const expired = await expireSessionNow();
    if (expired) await applySession(expired);
  }, [applySession]);

  const value = useMemo(() => ({
    status,
    session,
    pinState,
    user: session
      ? {
          username: session.username,
          displayName: session.displayName,
          roles: session.roles ?? [],
          role: session.role ?? 'teacher',
          schoolId: session.schoolId ?? null,
          schoolName: session.schoolName ?? null,
        }
      : null,
    cognitoConfigured: isCognitoConfigured(),
    signIn,
    signUp,
    confirmSignUp,
    resendConfirmationCode,
    signOut,
    unlockWithPin,
    enrolPin,
    simulateExpiry
  }), [
    status, session, pinState, signIn, signUp, confirmSignUp,
    resendConfirmationCode, signOut, unlockWithPin, enrolPin, simulateExpiry
  ]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside an AuthProvider');
  return ctx;
}
