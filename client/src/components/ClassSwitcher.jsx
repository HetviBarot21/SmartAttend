import { useCallback, useEffect, useState } from 'react';
import { getClasses, getStudentsByClass, classLabel } from '../db/database';
import CreateClassForm from './CreateClassForm';

/**
 * Bottom sheet from the top-bar class title: switch the active class, create a
 * new one, or jump to the roster editor for the current class.
 */
export default function ClassSwitcher({ activeClassId, onPick, onManageRoster, onClose }) {
  const [classes, setClasses] = useState([]);
  const [counts, setCounts] = useState({});
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const list = await getClasses();
    setClasses(list);
    const entries = await Promise.all(
      list.map(async (c) => [c.classGroupId, (await getStudentsByClass(c.classGroupId)).length]),
    );
    setCounts(Object.fromEntries(entries));
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <div className="sheet" role="dialog" aria-label="Classes" onClick={(e) => e.stopPropagation()}>
        <div className="sheet__grip" />

        {creating ? (
          <>
            <div className="sheet__name">New class</div>
            <CreateClassForm
              submitLabel="Create & switch to it"
              onCancel={() => setCreating(false)}
              onCreated={(cls) => { onPick(cls.classGroupId); }}
            />
          </>
        ) : (
          <>
            <div className="sheet__name">Your classes</div>
            <div className="sheet__sub">{classes.length} class{classes.length === 1 ? '' : 'es'} on this device</div>

            {classes.map((c) => (
              <button
                key={c.classGroupId}
                type="button"
                className="class-row"
                aria-current={c.classGroupId === activeClassId ? 'true' : undefined}
                onClick={() => onPick(c.classGroupId)}
              >
                <span>
                  <span className="class-row__name">{classLabel(c)}</span>
                  <span className="class-row__meta">
                    {counts[c.classGroupId] ?? 0} student{counts[c.classGroupId] === 1 ? '' : 's'}
                    {c.academicYear ? ` · ${c.academicYear}` : ''}
                  </span>
                </span>
                {c.classGroupId === activeClassId && <span className="class-row__tick">✓</span>}
              </button>
            ))}

            <div className="sheet__row" style={{ borderTop: '1px solid var(--line-soft)', marginTop: 8 }}>
              <span>Add / remove students in this class</span>
              <button type="button" className="linkbtn" onClick={onManageRoster}>Roster</button>
            </div>

            <button type="button" className="btn btn--ghost" style={{ marginTop: 10 }} onClick={() => setCreating(true)}>
              + New class
            </button>
          </>
        )}
      </div>
    </div>
  );
}
