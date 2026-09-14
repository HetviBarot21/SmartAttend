import { useCallback, useEffect, useState } from 'react';
import {
  getStudentsByClass, addStudent, removeStudent, classLabel,
} from '../db/database';
import { seedDemoClass } from '../db/seedData';
import CreateClassForm from './CreateClassForm';
import Avatar from './Avatar';
import { CapIcon } from './icons';

/**
 * First-run setup, shown when the device has no classes yet. Two steps:
 *   1. create the class
 *   2. enrol its students (name + admission no); each gets an RFID card number
 *      issued automatically, ready to print onto a physical card.
 * A "load a sample class" shortcut seeds the Form 3 B demo instead.
 */
export default function SetupWizard({ onDone }) {
  const [cls, setCls] = useState(null);
  const [students, setStudents] = useState([]);
  const [name, setName] = useState('');
  const [admissionNo, setAdmissionNo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const reload = useCallback(async () => {
    if (!cls) return;
    setStudents(await getStudentsByClass(cls.classGroupId));
  }, [cls]);

  useEffect(() => { reload(); }, [reload]);

  async function handleAddStudent(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await addStudent({ classGroupId: cls.classGroupId, fullName: name, admissionNo });
      setName(''); setAdmissionNo('');
      await reload();
    } catch (err) {
      setError(err.message ?? 'Could not add the student');
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(studentId) {
    setBusy(true);
    try {
      await removeStudent(studentId);
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function loadSample() {
    setBusy(true);
    try {
      const { classGroupId } = await seedDemoClass();
      onDone(classGroupId);
    } finally {
      setBusy(false);
    }
  }

  // -- step 1 : create the class -------------------------------------------- //
  if (!cls) {
    return (
      <div className="auth">
        <div className="auth__card auth__card--wide">
          <div className="auth__logo"><CapIcon size={24} /></div>
          <h1 className="auth__brand">Set up SmartAttend</h1>
          <p className="auth__tagline">Start by creating your class</p>

          <CreateClassForm onCreated={setCls} submitLabel="Create class & add students" />

          <div className="auth__foot">
            <button type="button" className="linkbtn" onClick={loadSample} disabled={busy}>
              Just exploring? Load a sample class
            </button>
          </div>
        </div>
      </div>
    );
  }

  // -- step 2 : add students ---------------------------------------------- //
  return (
    <div className="auth">
      <div className="auth__card auth__card--wide">
        <div className="auth__logo"><CapIcon size={24} /></div>
        <h1 className="auth__brand">Enrol students</h1>
        <p className="auth__tagline">{classLabel(cls)} · {students.length} enrolled</p>

        <form className="card" onSubmit={handleAddStudent}>
          {error && <div className="notice notice--err" role="alert">{error}</div>}

          <div className="field">
            <label className="field__label" htmlFor="sw-name">Full name</label>
            <input
              id="sw-name" className="field__input" type="text" autoComplete="off"
              placeholder="e.g. Amina Wanjiru" value={name}
              onChange={(e) => setName(e.target.value)} disabled={busy} required
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="sw-adm">Admission no. <span style={{ fontWeight: 400 }}>(optional)</span></label>
            <input
              id="sw-adm" className="field__input" type="text" autoComplete="off"
              placeholder="3B/011" value={admissionNo}
              onChange={(e) => setAdmissionNo(e.target.value)} disabled={busy}
            />
          </div>
          <p className="card__hint" style={{ margin: '0 0 10px' }}>
An RFID card number is issued automatically. Print cards from the roster later.
          </p>
          <button className="btn btn--secondary" type="submit" disabled={busy || name.trim() === ''}>
            Enrol student
          </button>
        </form>

        {students.length > 0 && (
          <div className="roll">
            {students.map((s) => (
              <div key={s.studentId} className="roll-row">
                <Avatar name={s.fullName} size="sm" />
                <div className="roll-row__who" style={{ cursor: 'default' }}>
                  <span className="roll-row__name">{s.fullName}</span>
                  <span className="roll-row__id">
                    Adm {s.admissionNo || '—'} · card <b>{s.cardUid}</b>
                  </span>
                </div>
                <button
                  type="button" className="roster-x" aria-label={`Remove ${s.fullName}`}
                  onClick={() => handleRemove(s.studentId)} disabled={busy}
                >×</button>
              </div>
            ))}
          </div>
        )}

        <div aria-hidden="true" style={{ height: 16 }} />
        <button
          type="button" className="btn"
          onClick={() => onDone(cls.classGroupId)}
          disabled={busy}
        >
          {students.length === 0 ? 'Skip for now' : `Done, ${students.length} student${students.length === 1 ? '' : 's'}`}
        </button>
      </div>
    </div>
  );
}
