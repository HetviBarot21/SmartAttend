import { navItems } from './BottomNav';
import { CapIcon } from './icons';

/** Desktop (>=768px) left rail. Same props as BottomNav. */
export default function SideNav({ active, onChange, alertCount = 0, role, classLabel, onSwitchClass, onManageRoster }) {
  return (
    <nav className="side-nav" aria-label="Primary">
      <div className="side-nav__brand">
        <CapIcon size={20} />
        <span>SmartAttend</span>
      </div>

      {classLabel && (
        <button type="button" className="side-nav__class" onClick={onSwitchClass}>
          {classLabel}
        </button>
      )}

      <div className="side-nav__items">
        {navItems(role).map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            className="side-nav__item"
            aria-current={active === id ? 'page' : undefined}
            onClick={() => onChange(id)}
          >
            <Icon size={18} />
            <span>{label}{id === 'alerts' && alertCount > 0 ? ` (${alertCount})` : ''}</span>
          </button>
        ))}
      </div>

      {onManageRoster && role !== 'admin' && (
        <button type="button" className="side-nav__item side-nav__item--muted" onClick={onManageRoster}>
          Manage roster
        </button>
      )}
    </nav>
  );
}
