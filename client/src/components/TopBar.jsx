import { ChevronDownIcon, ChevronRightIcon, ChevronLeftIcon, UserIcon, CapIcon } from './icons';

/**
 * Screen header with a breadcrumb, e.g. "Form 3 B > At-risk Students > Kevin".
 * Each crumb is `{ label, onClick?, picker? }`; a crumb with `onClick` is a link,
 * `picker` adds a dropdown chevron (the class switcher). On phones a deep page
 * shows only "< Parent" and the current page.
 */
export default function TopBar({ crumbs = [], online, onAccount }) {
  const current = crumbs[crumbs.length - 1];
  const parent = crumbs.length > 2 ? crumbs[crumbs.length - 2] : null;

  return (
    <header className="topbar">
      <nav className={`topbar__crumbs${parent ? ' topbar__crumbs--deep' : ''}`} aria-label="Breadcrumb">
        <span className="topbar__logo" aria-hidden="true"><CapIcon size={16} /></span>

        {parent && (
          <button type="button" className="topbar__up" onClick={parent.onClick}>
            <ChevronLeftIcon size={16} />
            {parent.label}
          </button>
        )}

        <ol className="crumbs">
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <li key={`${i}-${c.label}`} className={c.picker ? 'crumbs__item crumbs__item--picker' : 'crumbs__item'}>
                {last ? (
                  <h1 className="screen-title" aria-current="page">{c.label}</h1>
                ) : (
                  <button
                    type="button"
                    className="crumbs__link"
                    onClick={c.onClick}
                    title={c.picker ? 'Switch class' : `Go to ${c.label}`}
                  >
                    {c.label}
                    {c.picker && <ChevronDownIcon size={14} />}
                  </button>
                )}
                {!last && <ChevronRightIcon size={14} className="crumbs__sep" />}
              </li>
            );
          })}
        </ol>
        {current && <span className="sr-only">Current page: {current.label}</span>}
      </nav>

      <div className="topbar__right">
        {online !== undefined && (
          <span className={`status-chip status-chip--${online ? 'online' : 'offline'}`}>
            <span className={`dot dot--${online ? 'present' : 'late'}`} />
            {online ? 'Online' : 'Offline'}
          </span>
        )}
        {onAccount && (
          <button
            type="button"
            className="avatar-btn"
            onClick={onAccount}
            aria-label="Account and sync status"
          >
            <UserIcon size={18} />
          </button>
        )}
      </div>
    </header>
  );
}
