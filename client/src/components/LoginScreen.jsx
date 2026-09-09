import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { CapIcon, MailIcon, LockIcon, EyeIcon, EyeOffIcon, KeypadIcon } from './icons';

export default function LoginScreen() {
  const { signIn, cognitoConfigured } = useAuth();
  const online = useOnlineStatus();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pinHint, setPinHint] = useState(false);

  // Real Cognito needs the network. The local fallback does not, so first-time
  // sign-in is only blocked once a pool is actually configured.
  const blocked = cognitoConfigured && !online;

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      setError(err.message ?? 'Sign in failed');
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <form className="auth__card" onSubmit={handleSubmit}>
        <div className="auth__logo">
          <CapIcon size={24} />
        </div>
        <h1 className="auth__brand">SmartAttend AI</h1>
        <p className="auth__tagline">Sign in to continue</p>

        {blocked && (
          <div className="notice notice--warn" role="status">
            You’re offline. Connect to the internet to sign in for the first time on this device.
          </div>
        )}
        {error && <div className="notice notice--err" role="alert">{error}</div>}

        <div className="field">
          <label className="field__label" htmlFor="email">Email address</label>
          <div className="field__wrap">
            <span className="field__icon"><MailIcon size={18} /></span>
            <input
              id="email"
              className="field__input"
              type="email"
              inputMode="email"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              placeholder="Email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy || blocked}
              required
            />
          </div>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="password">Password</label>
          <div className="field__wrap">
            <span className="field__icon"><LockIcon size={18} /></span>
            <input
              id="password"
              className="field__input field__input--reveal"
              type={reveal ? 'text' : 'password'}
              autoComplete="current-password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy || blocked}
              required
            />
            <button
              type="button"
              className="field__reveal"
              onClick={() => setReveal((r) => !r)}
              aria-label={reveal ? 'Hide password' : 'Show password'}
            >
              {reveal ? <EyeOffIcon size={18} /> : <EyeIcon size={18} />}
            </button>
          </div>
        </div>

        <button className="btn" type="submit" disabled={busy || blocked}>
          {busy ? 'Signing in…' : 'Sign In'}
        </button>

        <div className="auth__divider">or</div>

        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => setPinHint(true)}
        >
          <KeypadIcon size={18} />
          Offline Mode — Use PIN
        </button>

        {pinHint && (
          <p className="devnote" role="status">
            Your PIN unlocks SmartAttend automatically once a signed-in session has expired offline.
            On a device that has been signed out completely, sign in online once — after that you can
            keep working with just your PIN.
          </p>
        )}

        {!cognitoConfigured && (
          <p className="devnote">
            <strong>Local authentication mode.</strong> No Cognito user pool is configured,
            so any email and password creates a device-local session. Set
            <code> VITE_COGNITO_USER_POOL_ID </code> and <code> VITE_COGNITO_CLIENT_ID </code>
            to authenticate against AWS.
          </p>
        )}
      </form>
    </div>
  );
}
