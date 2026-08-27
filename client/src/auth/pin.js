import bcrypt from 'bcryptjs';
import { db } from '../db/database';

/**
 * Offline PIN fallback (US-11).
 *
 * A teacher's Cognito JWT expires after an hour. In a school with no network
 * they cannot refresh it, so a locally verified PIN unlocks the app for the
 * rest of the day. The PIN is only ever stored as a bcrypt hash, and it is
 * only enrolled after a successful online Cognito login - it can never be the
 * first credential the device has seen.
 */

export const PIN_LENGTH = 4;
export const MAX_ATTEMPTS = 3;
export const LOCKOUT_MS = 15 * 60 * 1000;

// 10 rounds: ~100ms on the low-end Android devices this targets. Higher costs
// push PIN entry past the point where a teacher would tolerate it at the gate.
const SALT_ROUNDS = 10;

const TRIVIAL_PINS = new Set(['0000', '1111', '2222', '3333', '4444', '5555',
  '6666', '7777', '8888', '9999', '1234', '4321', '0123']);

export class PinError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'PinError';
    this.code = code;
    Object.assign(this, detail);
  }
}

export function validatePinFormat(pin) {
  if (typeof pin !== 'string' || !new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)) {
    throw new PinError('INVALID_FORMAT', `PIN must be exactly ${PIN_LENGTH} digits`);
  }
  if (TRIVIAL_PINS.has(pin)) {
    throw new PinError('TOO_WEAK', 'Choose a less predictable PIN');
  }
  return true;
}

/** Enrol or replace a teacher's offline PIN. Call only after an online login. */
export async function setPin(username, pin) {
  validatePinFormat(pin);
  const pinHash = await bcrypt.hash(pin, SALT_ROUNDS);
  const now = new Date().toISOString();
  const existing = await db.pinCredentials.where('username').equals(username).first();

  const record = {
    username,
    pinHash,
    failedAttempts: 0,
    lockedUntil: null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };

  if (existing) await db.pinCredentials.update(existing.id, record);
  else await db.pinCredentials.add(record);

  return { username, updatedAt: now };
}

export async function hasPin(username) {
  return (await db.pinCredentials.where('username').equals(username).count()) > 0;
}

export async function getPinStatus(username, now = Date.now()) {
  const cred = await db.pinCredentials.where('username').equals(username).first();
  if (!cred) return { enrolled: false, locked: false, attemptsRemaining: MAX_ATTEMPTS };

  const locked = cred.lockedUntil != null && cred.lockedUntil > now;
  return {
    enrolled: true,
    locked,
    lockedUntil: locked ? cred.lockedUntil : null,
    attemptsRemaining: locked ? 0 : MAX_ATTEMPTS - cred.failedAttempts
  };
}

/**
 * Verify a PIN, counting failures towards a lockout.
 *
 * Attempt counters live in IndexedDB, not memory, so reloading the page or
 * force-quitting the browser does not hand an attacker a fresh set of guesses.
 *
 * @throws {PinError} NOT_ENROLLED | LOCKED | WRONG_PIN
 */
export async function verifyPin(username, pin, now = Date.now()) {
  const cred = await db.pinCredentials.where('username').equals(username).first();
  if (!cred) throw new PinError('NOT_ENROLLED', 'No offline PIN set on this device');

  if (cred.lockedUntil != null && cred.lockedUntil > now) {
    throw new PinError('LOCKED', 'Too many incorrect attempts', {
      lockedUntil: cred.lockedUntil,
      minutesRemaining: Math.ceil((cred.lockedUntil - now) / 60000)
    });
  }

  // Lockout has expired - clear it before this attempt is judged.
  if (cred.lockedUntil != null) {
    await db.pinCredentials.update(cred.id, { failedAttempts: 0, lockedUntil: null });
    cred.failedAttempts = 0;
    cred.lockedUntil = null;
  }

  const ok = await bcrypt.compare(String(pin), cred.pinHash);

  if (!ok) {
    const failedAttempts = cred.failedAttempts + 1;
    const lockedUntil = failedAttempts >= MAX_ATTEMPTS ? now + LOCKOUT_MS : null;
    await db.pinCredentials.update(cred.id, { failedAttempts, lockedUntil });

    throw new PinError('WRONG_PIN', 'Incorrect PIN', {
      attemptsRemaining: Math.max(0, MAX_ATTEMPTS - failedAttempts),
      lockedUntil,
      minutesRemaining: lockedUntil ? Math.ceil(LOCKOUT_MS / 60000) : 0
    });
  }

  await db.pinCredentials.update(cred.id, { failedAttempts: 0, lockedUntil: null });
  return { username, verifiedAt: new Date(now).toISOString() };
}

/** Called after a successful online login, which supersedes any offline lockout. */
export async function clearLockout(username) {
  const cred = await db.pinCredentials.where('username').equals(username).first();
  if (cred) await db.pinCredentials.update(cred.id, { failedAttempts: 0, lockedUntil: null });
}
