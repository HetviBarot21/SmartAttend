import { useEffect } from 'react';
import Avatar from './Avatar';
import { SyncIcon, RosterIcon, KeypadIcon, LogOutIcon } from './icons';

const ROLE_LABEL = { admin: 'School admin', teacher: 'Teacher' };

/** Bottom sheet from the account button: who's signed in, sync state, settings, sign out. */
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

  const roleLine = [ROLE_LABEL[user?.role] ?? 'Teacher', user?.schoolName, pinSession ? 'PIN session' : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <div className="sheet" role="dialog" aria-label="Account" onClick={(e) => e.stopPropagation()}>
        <div className="sheet__grip" />

        <div className="account-head">
          <Avatar name={user?.displayName ?? user?.username ?? 'Teacher'} size="lg" />
          <div className="account-head__id">
            <div className="account-head__name">{user?.displayName ?? user?.username ?? 'Teacher'}</div>
            <div className="account-head__role">{roleLine}</div>
          </div>
          <span className={`status-dot status-dot--${online ? 'online' : 'offline'}`} title={online ? 'Online' : 'Offline'} />
        </div>

        <div className="account-list">
          <div className="account-row">
            <span className="account-row__icon"><SyncIcon size={16} /></span>
            <span className="account-row__label">
              {pending > 0 ? `${pending} record${pending === 1 ? '' : 's'} awaiting sync` : 'All records synced'}
            </span>
          </div>

          {onManageRoster && (
            <button type="button" className="account-row account-row--action" onClick={onManageRoster}>
              <span className="account-row__icon"><RosterIcon size={16} /></span>
              <span className="account-row__label">Class roster</span>
              <span className="account-row__go">Manage</span>
            </button>
          )}

          {onManagePin && (
            <button type="button" className="account-row account-row--action" onClick={onManagePin}>
              <span className="account-row__icon"><KeypadIcon size={16} /></span>
              <span className="account-row__label">Offline PIN{pinEnrolled ? '' : ' (not set)'}</span>
              <span className="account-row__go">{pinEnrolled ? 'Change' : 'Set up'}</span>
            </button>
          )}
        </div>

        {onSimulateExpiry && (
          <div className="devnote account-dev">
            <span>Dev: simulate session expiry</span>
            <button type="button" className="linkbtn" onClick={onSimulateExpiry}>Run</button>
          </div>
        )}

        <button type="button" className="btn btn--ghost account-signout" onClick={onSignOut}>
          <LogOutIcon size={16} />
          Sign out
        </button>
        <p className="account-username">Signed in as {user?.username}</p>
      </div>
    </div>
  );
}
