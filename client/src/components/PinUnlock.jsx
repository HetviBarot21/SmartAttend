import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { MAX_ATTEMPTS, PIN_LENGTH } from '../auth/pin';

function minutesLeft(lockedUntil, now) {
  return Math.max(0, Math.ceil((lockedUntil - now) / 60000));
}

export default function PinUnlock() {
  const { session, pinState, unlockWithPin, signOut } = useAuth();
  const [pin, setPin] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef(null);

  const lockedUntil = pinState.lockedUntil ?? null;
  const locked = lockedUntil != null && lockedUntil > now;

  // Tick only while a lockout is counting down, so the input re-enables on its
  // own instead of stranding the teacher on a stale "try again in 1 minute".
  useEffect(() => {
    if (!locked) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [locked]);

  useEffect(() => {
    if (!locked) inputRef.current?.focus();
  }, [locked]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await unlockWithPin(pin);
    } catch (err) {
      setPin('');
      setNow(Date.now());
      if (err.code === 'LOCKED') {
        setError(`Too many incorrect attempts. Try again in ${err.minutesRemaining} minute(s), or sign in with your password.`);
      } else if (err.code === 'WRONG_PIN') {
        setError(
          err.attemptsRemaining > 0
            ? `Incorrect PIN. ${err.attemptsRemaining} attempt(s) remaining.`
            : `Incorrect PIN. Locked for ${err.minutesRemaining} minute(s).`
        );
      } else if (err.code === 'NOT_ENROLLED') {
        setError('No PIN is set on this device. Sign in with your password instead.');
      } else {
        setError(err.message ?? 'Could not verify PIN');
      }
      setBusy(false);
    }
  }

  if (!pinState.enrolled) {
    return (
      <div className="auth">
        <div className="auth__card">
          <h1 className="auth__brand">Session expired</h1>
          <p className="auth__help">
            Your sign-in has expired and no offline PIN is set on this device.
            Connect to the internet and sign in with your password.
          </p>
          <button className="btn" type="button" onClick={signOut}>Back to sign in</button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth">
      <form className="auth__card" onSubmit={handleSubmit}>
        <h1 className="auth__brand">Session expired</h1>
        <p className="auth__tagline">{session?.displayName ?? session?.username}</p>

        <h2 className="auth__legend">Enter your PIN</h2>
        <p className="auth__help">
          Your one-hour sign-in has expired. Enter your {PIN_LENGTH}-digit PIN to keep
          recording attendance — no internet needed.
        </p>

        {error && <div className="notice notice--err" role="alert">{error}</div>}

        {locked ? (
          <div className="notice notice--warn" role="status">
            Locked after {MAX_ATTEMPTS} incorrect attempts.
            Unlocks in {minutesLeft(lockedUntil, now)} minute(s).
          </div>
        ) : (
          pinState.attemptsRemaining < MAX_ATTEMPTS && (
            <div className="notice notice--warn" role="status">
              {pinState.attemptsRemaining} of {MAX_ATTEMPTS} attempt(s) remaining before this device locks.
            </div>
          )
        )}

        <div className="field">
          <label className="field__label" htmlFor="pin">PIN</label>
          <input
            id="pin"
            ref={inputRef}
            className="field__input field__input--pin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={PIN_LENGTH}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            disabled={busy || locked}
            aria-describedby="pin-help"
          />
          <span id="pin-help" className="roll__locked">{PIN_LENGTH} digits</span>
        </div>

        <button className="btn" type="submit" disabled={busy || locked || pin.length !== PIN_LENGTH}>
          {busy ? 'Checking…' : 'Unlock'}
        </button>

        <div className="auth__foot">
          <button className="linkbtn" type="button" onClick={signOut}>
            Sign in with password instead
          </button>
        </div>
      </form>
    </div>
  );
}
