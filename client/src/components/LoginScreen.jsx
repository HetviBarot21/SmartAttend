import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useOnlineStatus } from '../hooks/useOnlineStatus';

export default function LoginScreen() {
  const { signIn, cognitoConfigured } = useAuth();
  const online = useOnlineStatus();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // Real Cognito needs the network. The local fallback does not, so offline
  // sign-in is only blocked once a pool is actually configured.
  const blocked = cognitoConfigured && !online;

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn(username.trim(), password);
    } catch (err) {
      setError(err.message ?? 'Sign in failed');
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <form className="auth__card" onSubmit={handleSubmit}>
        <h1 className="auth__brand">SmartAttend AI</h1>
        <p className="auth__tagline">Offline-first attendance</p>

        <h2 className="auth__legend">Teacher sign in</h2>
        <p className="auth__help">
          Sign in once while you have a connection. After that you can keep marking
          attendance offline, and unlock with your PIN when the session expires.
        </p>

        {blocked && (
          <div className="notice notice--warn" role="status">
            You are offline. Connect to the internet to sign in for the first time on this device.
          </div>
        )}

        {error && <div className="notice notice--err" role="alert">{error}</div>}

        <div className="field">
          <label className="field__label" htmlFor="username">Username</label>
          <input
            id="username"
            className="field__input"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={busy || blocked}
            required
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="password">Password</label>
          <input
            id="password"
            className="field__input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy || blocked}
            required
          />
        </div>

        <button className="btn" type="submit" disabled={busy || blocked}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        {!cognitoConfigured && (
          <p className="devnote">
            <strong>Local authentication mode.</strong> No Cognito user pool is configured,
            so any username and password creates a device-local session. Set
            VITE_COGNITO_USER_POOL_ID and VITE_COGNITO_CLIENT_ID to authenticate against AWS.
          </p>
        )}
      </form>
    </div>
  );
}
