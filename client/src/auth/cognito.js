import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails
} from 'amazon-cognito-identity-js';
import { db } from '../db/database';

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

function localSession(username, now = Date.now()) {
  return {
    key: SESSION_KEY,
    mode: 'local',
    username,
    displayName: username,
    roles: ['teacher'],
    idToken: null,
    refreshToken: null,
    expiresAt: now + LOCAL_TOKEN_TTL_MS,
    issuedAt: now
  };
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
  if (!pool) return persist(localSession(username));

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
