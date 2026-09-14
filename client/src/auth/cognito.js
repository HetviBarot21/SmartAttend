import {
  CognitoUserPool,
  CognitoUser,
  CognitoUserAttribute,
  AuthenticationDetails
} from 'amazon-cognito-identity-js';
import { db, LOCAL_SCHOOL_ID } from '../db/database';

/**
 * Amazon Cognito authentication with a local fallback.
 *
 * Sprint 1 runs before the Cognito user pool is provisioned (Sprint 2), so
 * when no pool is configured this module issues a LOCAL session instead of
 * failing closed. That session is clearly marked mode:'local', is never
 * accepted by the AWS API Gateway authoriser, and exists only so the offline
 * PWA is demonstrable end to end. Setting VITE_COGNITO_USER_POOL_ID and
 * VITE_COGNITO_CLIENT_ID switches the whole module to real Cognito with no
 * other code change.
 */

const USER_POOL_ID = import.meta.env?.VITE_COGNITO_USER_POOL_ID ?? '';
const CLIENT_ID = import.meta.env?.VITE_COGNITO_CLIENT_ID ?? '';

export const SESSION_KEY = 'session';
const LOCAL_TOKEN_TTL_MS = 60 * 60 * 1000; // matches the 1-hour Cognito ID token expiry

export function isCognitoConfigured() {
  return Boolean(USER_POOL_ID && CLIENT_ID);
}

let poolInstance = null;
function userPool() {
  if (!isCognitoConfigured()) return null;
  if (!poolInstance) {
    poolInstance = new CognitoUserPool({ UserPoolId: USER_POOL_ID, ClientId: CLIENT_ID });
  }
  return poolInstance;
}

export class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

/** Read a JWT payload without verifying it. Verification is the API Gateway authoriser's job. */
export function decodeJwt(token) {
  try {
    const payload = token.split('.')[1];
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(decodeURIComponent(escape(json)));
  } catch {
    return null;
  }
}

function sessionFromCognito(cognitoSession, username) {
  const idToken = cognitoSession.getIdToken();
  const claims = idToken.decodePayload();
  return {
    key: SESSION_KEY,
    mode: 'cognito',
    username,
    displayName: claims.name ?? claims.email ?? username,
    roles: claims['cognito:groups'] ?? ['teacher'],
    idToken: idToken.getJwtToken(),
    refreshToken: cognitoSession.getRefreshToken().getToken(),
    // Cognito exp is in seconds.
    expiresAt: claims.exp * 1000,
    issuedAt: Date.now()
  };
}

/** @param {'teacher'|'admin'} role */
function localSession(username, displayName, role = 'teacher', schoolName = null, now = Date.now()) {
  return {
    key: SESSION_KEY,
    mode: 'local',
    username,
    displayName: displayName || username,
    roles: [role],
    role,
    // Local mode is single-school (no server-side identity system - see
    // PROJECT_CONTEXT.md). Every device shares LOCAL_SCHOOL_ID so an admin's
    // cross-class reports and a teacher's roster pushes land in the same
    // school row server-side.
    schoolId: LOCAL_SCHOOL_ID,
    schoolName: schoolName || null,
    idToken: null,
    refreshToken: null,
    expiresAt: now + LOCAL_TOKEN_TTL_MS,
    issuedAt: now
  };
}

/**
 * Local-mode account profiles. Before the Cognito pool exists (Sprint 2) there
 * is no server to hold a teacher's name, so "sign up" just records a display
 * name, role and (for admins) school name on the device, keyed by email, in
 * the same IndexedDB table the session lives in. It is not a credential store
 * - local mode still accepts any password - it only lets the app greet the
 * teacher by name and restore their role on the next sign-in.
 */
const accountKey = (email) => `account:${String(email).trim().toLowerCase()}`;

async function saveLocalAccount(email, displayName, role = 'teacher', schoolName = null) {
  await db.authState.put({
    key: accountKey(email),
    email: String(email).trim().toLowerCase(),
    displayName,
    role,
    schoolName,
    createdAt: new Date().toISOString()
  });
}

async function loadLocalAccount(email) {
  return (await db.authState.get(accountKey(email))) ?? null;
}

export function isSessionValid(session, now = Date.now()) {
  return Boolean(session) && typeof session.expiresAt === 'number' && session.expiresAt > now;
}

async function persist(session) {
  await db.authState.put(session);
  return session;
}

/**
 * Authenticate against Cognito, or mint a local session when no pool is configured.
 * @throws {AuthError} NOT_AUTHORIZED | NEW_PASSWORD_REQUIRED | NETWORK
 */
export async function signIn(username, password) {
  if (!username || !password) {
    throw new AuthError('INVALID_INPUT', 'Enter both a username and a password');
  }

  const pool = userPool();
  if (!pool) {
    const account = await loadLocalAccount(username);
    return persist(localSession(username, account?.displayName, account?.role, account?.schoolName));
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new AuthError('NETWORK', 'No connection - sign in with your offline PIN instead');
  }

  const user = new CognitoUser({ Username: username, Pool: pool });
  const details = new AuthenticationDetails({ Username: username, Password: password });

  const cognitoSession = await new Promise((resolve, reject) => {
    user.authenticateUser(details, {
      onSuccess: resolve,
      onFailure: (err) => {
        const code = err?.code === 'NetworkError' ? 'NETWORK' : 'NOT_AUTHORIZED';
        reject(new AuthError(code, err?.message ?? 'Sign in failed'));
      },
      newPasswordRequired: () =>
        reject(new AuthError('NEW_PASSWORD_REQUIRED', 'A new password is required for this account'))
    });
  });

  return persist(sessionFromCognito(cognitoSession, username));
}

/**
 * Register a new teacher.
 *
 * Local mode (no pool): records the display name on the device and signs in
 * immediately - there is nothing to confirm. Returns `{ needsConfirmation: false,
 * session }`.
 *
 * Cognito mode: calls the pool's sign-up, which emails a verification code.
 * Returns `{ needsConfirmation: true, username }`; the caller then collects the
 * code and calls confirmSignUp() before the account can sign in.
 *
 * @param {'teacher'|'admin'} [role] local mode only - Cognito mode derives role from `cognito:groups`
 * @throws {AuthError} INVALID_INPUT | NETWORK | SIGNUP_FAILED
 */
export async function signUp({ name, email, password, role = 'teacher', schoolName = null }) {
  const displayName = name?.trim();
  const username = email?.trim();

  if (!displayName || !username || !password) {
    throw new AuthError('INVALID_INPUT', 'Enter your name, email and a password');
  }
  if (password.length < 8) {
    throw new AuthError('INVALID_INPUT', 'Password must be at least 8 characters');
  }

  const pool = userPool();
  if (!pool) {
    await saveLocalAccount(username, displayName, role, schoolName);
    const session = await persist(localSession(username, displayName, role, schoolName));
    return { needsConfirmation: false, session };
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new AuthError('NETWORK', 'Connect to the internet to create an account');
  }

  const attributes = [
    new CognitoUserAttribute({ Name: 'email', Value: username }),
    new CognitoUserAttribute({ Name: 'name', Value: displayName })
  ];

  await new Promise((resolve, reject) => {
    pool.signUp(username, password, attributes, [], (err, result) => {
      if (err) {
        const code = err?.code === 'NetworkError' ? 'NETWORK' : 'SIGNUP_FAILED';
        reject(new AuthError(code, err?.message ?? 'Could not create the account'));
        return;
      }
      resolve(result);
    });
  });

  return { needsConfirmation: true, username };
}

/**
 * Confirm a Cognito sign-up with the emailed code, then sign in so the teacher
 * lands in the app straight away.
 * @throws {AuthError} INVALID_INPUT | NETWORK | CONFIRM_FAILED
 */
export async function confirmSignUp(username, code, password) {
  const pool = userPool();
  if (!pool) {
    // Local mode never issues a confirmation step.
    return signIn(username, password);
  }
  if (!username || !code) {
    throw new AuthError('INVALID_INPUT', 'Enter the verification code from your email');
  }

  const user = new CognitoUser({ Username: username.trim(), Pool: pool });
  await new Promise((resolve, reject) => {
    user.confirmRegistration(code.trim(), true, (err, result) => {
      if (err) {
        const c = err?.code === 'NetworkError' ? 'NETWORK' : 'CONFIRM_FAILED';
        reject(new AuthError(c, err?.message ?? 'Could not confirm the account'));
        return;
      }
      resolve(result);
    });
  });

  if (password) return signIn(username, password);
  return null;
}

/** Re-send the Cognito sign-up verification code. No-op in local mode. */
export async function resendConfirmationCode(username) {
  const pool = userPool();
  if (!pool) return;
  const user = new CognitoUser({ Username: username.trim(), Pool: pool });
  await new Promise((resolve, reject) => {
    user.resendConfirmationCode((err, result) => {
      if (err) reject(new AuthError('NETWORK', err?.message ?? 'Could not resend the code'));
      else resolve(result);
    });
  });
}

/** The last session written to IndexedDB, valid or expired. */
export async function loadStoredSession() {
  return (await db.authState.get(SESSION_KEY)) ?? null;
}

/**
 * Extend the session after a PIN unlock. The teacher has proved possession of
 * the device, but not to AWS - so a PIN-extended session stays flagged
 * pinVerified and holds no fresh ID token. Sprint 2's sync engine treats it as
 * unauthenticated for AWS purposes and re-authenticates once online.
 */
export async function extendSessionWithPin(session, now = Date.now()) {
  return persist({
    ...session,
    key: SESSION_KEY,
    pinVerified: true,
    expiresAt: now + LOCAL_TOKEN_TTL_MS,
    idTokenExpired: session.mode === 'cognito'
  });
}

export async function signOut() {
  const pool = userPool();
  const session = await loadStoredSession();
  if (pool && session?.username) {
    new CognitoUser({ Username: session.username, Pool: pool }).signOut();
  }
  await db.authState.delete(SESSION_KEY);
}

/**
 * Demo helper: backdate the stored session so it reads as expired.
 * Drives the "PIN login works after JWT expiry" step of the Sprint 1 demo
 * without waiting an hour. Exposed in dev builds only.
 */
export async function expireSessionNow() {
  const session = await loadStoredSession();
  if (!session) return null;
  return persist({ ...session, expiresAt: Date.now() - 1000, pinVerified: false });
}
