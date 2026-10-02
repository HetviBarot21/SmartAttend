import { navItems } from './BottomNav';
import Avatar from './Avatar';
import { CapIcon, ChevronDownIcon } from './icons';

const ROLE_LABEL = { admin: 'School admin', teacher: 'Teacher' };

/** Desktop (>=900px) sidebar: brand, class picker, navigation and the signed-in user. */
export default function SideNav({
  active, onChange, alertCount = 0, role, classLabel, onSwitchClass,
  user, online, pending = 0, onAccount, registerStatus = null,
}) {
  const name = user?.displayName ?? user?.username ?? 'Teacher';
  return (
    <nav className="side-nav" aria-label="Primary">
      <div className="side-nav__brand">
        <span className="side-nav__logo"><CapIcon size={18} /></span>
        <span>SmartAttend</span>
      </div>

      {classLabel && (
        <button type="button" className="side-nav__class" onClick={onSwitchClass}>
          <span>
            <span className="side-nav__class-label">Class</span>
            <span className="side-nav__class-name">{classLabel}</span>
          </span>
          <ChevronDownIcon size={16} />
        </button>
      )}

      <div className="side-nav__section">Menu</div>
      <div className="side-nav__items">
        {navItems(role).map(({ id, label, Icon, section }) => (
          <div key={id} className="side-nav__group">
            {section && <div className="side-nav__section">{section}</div>}
            <button
              type="button"
              className="side-nav__item"
              aria-current={active === id ? 'page' : undefined}
              onClick={() => onChange(id)}
            >
              <Icon size={18} />
              <span>{label}</span>
              {id === 'alerts' && alertCount > 0 && <span className="nav-count">{alertCount}</span>}
              {id === 'attendance' && registerStatus === 'due' && <span className="nav-flag nav-flag--due">Due</span>}
              {id === 'attendance' && registerStatus === 'done' && <span className="nav-flag nav-flag--done">Done</span>}
            </button>
          </div>
        ))}
      </div>

      {user && (
        <button type="button" className="side-nav__user" onClick={onAccount}>
          <Avatar name={name} size="sm" />
          <span className="side-nav__user-text">
            <span className="side-nav__user-name">{name}</span>
            <span className="side-nav__user-role">{ROLE_LABEL[role] ?? 'Teacher'}</span>
            <span className="side-nav__user-meta">
              <span className={`dot dot--${online ? 'present' : 'late'}`} />
              {online ? 'Online' : 'Offline'}
              {pending > 0 ? ` · ${pending} to sync` : ''}
            </span>
          </span>
        </button>
      )}
    </nav>
  );
}
