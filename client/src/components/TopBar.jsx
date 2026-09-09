import { ChevronLeftIcon, ChevronDownIcon, UserIcon } from './icons';

/**
 * Screen header: a title (or a back button) on the left, an account button on
 * the right. The account button carries the online/offline dot so that status
 * has a home on every screen without a full status bar. When `onTitleClick` is
 * set the title becomes a button (the class switcher).
 */
export default function TopBar({ title, onBack, online, onAccount, onTitleClick }) {
  return (
    <header className="topbar">
      {onBack ? (
        <button type="button" className="topbar__back" onClick={onBack}>
          <ChevronLeftIcon size={20} />
          {title}
        </button>
      ) : onTitleClick ? (
        <button type="button" className="screen-title screen-title--btn" onClick={onTitleClick}>
          {title}
          <ChevronDownIcon size={16} />
        </button>
      ) : (
        <h1 className="screen-title">{title}</h1>
      )}

      {onAccount && (
        <button
          type="button"
          className="avatar-btn"
          onClick={onAccount}
          aria-label="Account and sync status"
        >
          <UserIcon size={18} />
          <span
            className={`avatar-btn__dot avatar-btn__dot--${online ? 'online' : 'offline'}`}
          />
        </button>
      )}
    </header>
  );
}
