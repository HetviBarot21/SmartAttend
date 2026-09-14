import { useEffect } from 'react';

/**
 * Bottom sheet reached from the account button. Consolidates everything the old
 * header status bar carried: who is signed in, the connection state, how many
 * records are still queued, sign-out, and the dev-only session-expiry control.
 */
export default function AccountSheet({
  user,
  online,
  pending,
  pinSession,
  pinEnrolled,
  onManagePin,
  onManageRoster,
  onSignOut,
  onSimulateExpiry,
  onClose,
}) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <div
        className="sheet"
        role="dialog"
        aria-label="Account"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet__grip" />
        <div className="sheet__name">{user?.displayName ?? user?.username ?? 'Teacher'}</div>
        <div className="sheet__sub">
          {online ? 'Online' : 'Offline, saving to this device'}
          {pinSession ? ' · PIN session' : ''}
        </div>

        <div className="sheet__row">
          <span>Records awaiting sync</span>
          <strong>{pending}</strong>
        </div>

        {onManageRoster && (
          <div className="sheet__row">
            <span>Class roster</span>
            <button type="button" className="linkbtn" onClick={onManageRoster}>
              Add / remove students
            </button>
          </div>
        )}

        {onManagePin && (
          <div className="sheet__row">
            <span>Offline PIN{pinEnrolled ? '' : ' (not set)'}</span>
            <button type="button" className="linkbtn" onClick={onManagePin}>
              {pinEnrolled ? 'Change' : 'Set up'}
            </button>
          </div>
        )}

        {onSimulateExpiry && (
          <div className="sheet__row">
            <span>Simulate session expiry</span>
            <button type="button" className="linkbtn" onClick={onSimulateExpiry}>
              Run
            </button>
          </div>
        )}

        <div className="sheet__row" style={{ borderTop: '1px solid var(--line-soft)' }}>
          <span>Signed in as {user?.username}</span>
          <button type="button" className="linkbtn" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
