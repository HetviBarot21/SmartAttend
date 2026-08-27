import { useEffect, useState } from 'react';

/**
 * Tracks navigator.onLine.
 *
 * This reports whether the device has a network interface, not whether AWS is
 * reachable - a school on a captive-portal hotspot reads as online while every
 * sync fails. Sprint 2's sync engine treats it as a hint and still relies on
 * request failure to decide when to back off.
 */
export function useOnlineStatus() {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine
  );

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  return online;
}
