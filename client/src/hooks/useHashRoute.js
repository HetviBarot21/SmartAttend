import { useCallback, useEffect, useState } from 'react';

// Tab id -> URL slug. The hash keeps the current page on refresh and lets the
// browser / Android back button step back through pages.
const SLUGS = {
  dashboard: 'dashboard',
  attendance: 'register',
  heatmap: 'reports',
  alerts: 'at-risk',
  students: 'students',
  overview: 'school',
};
const TAB_BY_SLUG = Object.fromEntries(Object.entries(SLUGS).map(([tab, slug]) => [slug, tab]));

/** `#/at-risk/student/stu-007` -> { tab: 'alerts', studentId: 'stu-007', classId: null } */
export function parseHash(hash) {
  const [slug, kind, id] = hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  return {
    tab: TAB_BY_SLUG[slug] ?? 'dashboard',
    studentId: kind === 'student' && id ? id : null,
    classId: kind === 'class' && id ? id : null,
  };
}

export function toHash({ tab, studentId = null, classId = null }) {
  let hash = `#/${SLUGS[tab] ?? SLUGS.dashboard}`;
  if (studentId) hash += `/student/${encodeURIComponent(studentId)}`;
  else if (classId) hash += `/class/${encodeURIComponent(classId)}`;
  return hash;
}

/** Current route plus `navigate(next)`, which pushes a history entry. */
export function useHashRoute() {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));

  useEffect(() => {
    const canonical = toHash(parseHash(window.location.hash));
    if (window.location.hash !== canonical) window.history.replaceState(null, '', canonical);
    const onPop = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // `up: true` (breadcrumb parent) steps back when that is where we came
  // from, so the back button does not return to the page just left.
  const navigate = useCallback((next, { up = false } = {}) => {
    const hash = toHash(next);
    if (window.location.hash === hash) return;
    if (up && window.history.state?.from === hash) {
      window.history.back();
      return;
    }
    window.history.pushState({ from: window.location.hash }, '', hash);
    setRoute(parseHash(hash));
    window.scrollTo(0, 0);
  }, []);

  return [route, navigate];
}
