import { RosterIcon, GridIcon, BellIcon } from './icons';

const ITEMS = [
  { id: 'attendance', label: 'Attendance', Icon: RosterIcon },
  { id: 'heatmap', label: 'Heatmap', Icon: GridIcon },
  { id: 'alerts', label: 'Alerts', Icon: BellIcon },
];

export default function BottomNav({ active, onChange, alertCount = 0 }) {
  return (
    <nav className="bottom-nav" aria-label="Primary">
      {ITEMS.map(({ id, label, Icon }) => (
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
