import { useMemo, useState } from 'react';
import { createClass } from '../db/database';

/**
 * Reusable "create a class" form - used by the first-run SetupWizard and by
 * "New class" in the class switcher. The class name defaults to
 * "<grade> <stream>" but can be overridden.
 */
export default function CreateClassForm({ onCreated, onCancel, submitLabel = 'Create class' }) {
  const [grade, setGrade] = useState('');
  const [stream, setStream] = useState('');
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const derivedName = useMemo(
    () => [grade.trim(), stream.trim()].filter(Boolean).join(' ').trim(),
    [grade, stream],
  );
  const effectiveName = name.trim() || derivedName;

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const cls = await createClass({
        grade,
        stream,
        name: name.trim() || undefined,
        academicYear: Number(year) || undefined,
      });
      onCreated?.(cls);
    } catch (err) {
      setError(err.message ?? 'Could not create the class');
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={handleSubmit}>
      <h2 className="card__title">Class details</h2>
      <p className="card__hint">Name it however your school does — e.g. grade and stream.</p>

      {error && <div className="notice notice--err" role="alert">{error}</div>}

      <div className="field-row">
        <div className="field">
          <label className="field__label" htmlFor="cc-grade">Grade / form</label>
          <input
            id="cc-grade" className="field__input" type="text" autoComplete="off"
            placeholder="Form 3" value={grade} onChange={(e) => setGrade(e.target.value)}
            disabled={busy}
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="cc-stream">Stream</label>
          <input
            id="cc-stream" className="field__input" type="text" autoComplete="off"
            placeholder="B" value={stream} onChange={(e) => setStream(e.target.value)}
            disabled={busy}
          />
        </div>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="cc-name">
          Class name {derivedName && <span style={{ fontWeight: 400 }}>(defaults to “{derivedName}”)</span>}
        </label>
        <input
          id="cc-name" className="field__input" type="text" autoComplete="off"
          placeholder={derivedName || 'Class name'} value={name}
          onChange={(e) => setName(e.target.value)} disabled={busy}
        />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="cc-year">Academic year</label>
        <input
          id="cc-year" className="field__input" type="number" inputMode="numeric"
          value={year} onChange={(e) => setYear(e.target.value)} disabled={busy}
        />
      </div>

      <button className="btn" type="submit" disabled={busy || effectiveName === ''}>
        {busy ? 'Creating…' : submitLabel}
      </button>
      {onCancel && (
        <div className="auth__foot">
          <button type="button" className="linkbtn" onClick={onCancel} disabled={busy}>Cancel</button>
        </div>
      )}
    </form>
  );
}
