import { RosterIcon, GridIcon, BellIcon, ChartIcon } from './icons';

/** Nav items for the signed-in role. Shared by BottomNav (phone) and SideNav (desktop). */
export function navItems(role) {
  const items = [
    { id: 'attendance', label: 'Attendance', Icon: RosterIcon },
    { id: 'heatmap', label: 'Heatmap', Icon: GridIcon },
    { id: 'alerts', label: 'Alerts', Icon: BellIcon },
  ];
  if (role === 'admin') items.push({ id: 'overview', label: 'Overview', Icon: ChartIcon });
  return items;
}

export default function BottomNav({ active, onChange, alertCount = 0, role }) {
  return (
    <nav className="bottom-nav" aria-label="Primary">
      {navItems(role).map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          className="bottom-nav__item"
          aria-current={active === id ? 'page' : undefined}
          onClick={() => onChange(id)}
        >
          <span className="bottom-nav__pill">
            <Icon size={20} />
          </span>
          <span>
            {label}
            {id === 'alerts' && alertCount > 0 ? ` (${alertCount})` : ''}
          </span>
        </button>
      ))}
    </nav>
  );
}
