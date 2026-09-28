import {
  CognitoUserPool,
  CognitoUser,
  CognitoUserAttribute,
  AuthenticationDetails
} from 'amazon-cognito-identity-js';
import { db, LOCAL_SCHOOL_ID } from '../db/database';

/**
 * Amazon Cognito authentication. Without VITE_COGNITO_USER_POOL_ID and
 * VITE_COGNITO_CLIENT_ID it issues local sessions (mode: 'local') that AWS
 * never accepts.
 */

const USER_POOL_ID = import.meta.env?.VITE_COGNITO_USER_POOL_ID ?? '';
const CLIENT_ID = import.meta.env?.VITE_COGNITO_CLIENT_ID ?? '';

export const SESSION_KEY = 'session';
const LOCAL_TOKEN_TTL_MS = 60 * 60 * 1000;

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

/** Reads a JWT payload without verifying it. */
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
    expiresAt: claims.exp * 1000,
    issuedAt: Date.now()
  };
}

/** @param {'teacher'|'admin'|'system_admin'} role */
function localSession(username, displayName, role = 'teacher', schoolName = null, now = Date.now()) {
  return {
    key: SESSION_KEY,
    mode: 'local',
    username,
    displayName: displayName || username,
    roles: [role],
    role,
    // Local mode is single-school.
    schoolId: LOCAL_SCHOOL_ID,
    schoolName: schoolName || null,
    idToken: null,
    refreshToken: null,
    expiresAt: now + LOCAL_TOKEN_TTL_MS,
    issuedAt: now
  };
}

// Local-mode profiles (name, role, school) keyed by email. No passwords are stored.
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
 * Local mode signs in straight away. Cognito mode emails a code that must be
 * passed to confirmSignUp().
 *
 * @param {'teacher'|'admin'|'system_admin'} [role] local mode only
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
 * Confirm a Cognito sign-up with the emailed code, then sign in.
 * @throws {AuthError} INVALID_INPUT | NETWORK | CONFIRM_FAILED
 */
export async function confirmSignUp(username, code, password) {
  const pool = userPool();
  if (!pool) {
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

export async function loadStoredSession() {
  return (await db.authState.get(SESSION_KEY)) ?? null;
}

/** Extend the session after a PIN unlock. This does not refresh the AWS token. */
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

/** Dev helper: mark the stored session as expired. */
export async function expireSessionNow() {
  const session = await loadStoredSession();
  if (!session) return null;
  return persist({ ...session, expiresAt: Date.now() - 1000, pinVerified: false });
}
