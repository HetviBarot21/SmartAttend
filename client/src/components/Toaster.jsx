import { useEffect, useState } from 'react';
import { CheckCircleIcon, AlertTriangleIcon } from './icons';

const VISIBLE_MS = 3500;

/** Bottom-right stack of short confirmations ("Attendance saved"). */
export default function Toaster() {
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    let next = 0;
    const onToast = (e) => {
      const id = (next += 1);
      setToasts((list) => [...list, { id, ...e.detail }]);
      setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), VISIBLE_MS);
    };
    window.addEventListener('smartattend:toast', onToast);
    return () => window.removeEventListener('smartattend:toast', onToast);
  }, []);

  return (
    <div className="toaster" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.tone}`}>
          {t.tone === 'error' ? <AlertTriangleIcon size={16} /> : <CheckCircleIcon size={16} />}
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}
