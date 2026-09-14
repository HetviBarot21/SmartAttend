import { useCallback, useEffect, useState } from 'react';
import { addFollowUp, getFollowUpsForStudent, updateStudent } from '../db/database';
import { useAuth } from '../auth/AuthContext';
import { CheckCircleIcon, PhoneIcon, MailIcon } from './icons';

const METHOD_LABEL = {
  parent_call: 'Called parent/guardian',
  sms: 'Sent SMS',
  home_visit: 'Home visit',
  meeting: 'Met at school',
  other: 'Other',
};

function fmtWhen(iso) {
  const dt = new Date(iso);
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) +
    ' · ' + dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/** Guardian phone/email, shown as tap-to-call/email links, editable inline. */
function GuardianContact({ studentId, phone, email, onUpdated }) {
  const [editing, setEditing] = useState(false);
  const [phoneInput, setPhoneInput] = useState(phone ?? '');
  const [emailInput, setEmailInput] = useState(email ?? '');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const updated = await updateStudent(studentId, {
        guardianPhone: phoneInput.trim() || null,
        guardianEmail: emailInput.trim() || null,
      });
      onUpdated?.(updated);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <div className="guardian-contact guardian-contact--edit">
        <input
          className="field__input" type="tel" placeholder="Phone number"
          value={phoneInput} onChange={(e) => setPhoneInput(e.target.value)} disabled={busy}
        />
        <input
          className="field__input" type="email" placeholder="Email address"
          value={emailInput} onChange={(e) => setEmailInput(e.target.value)} disabled={busy}
        />
        <div className="guardian-contact__actions">
          <button type="button" className="btn btn--sm" onClick={save} disabled={busy}>Save</button>
          <button type="button" className="linkbtn linkbtn--muted" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="guardian-contact">
      {phone && (
        <a className="guardian-contact__link" href={`tel:${phone}`}>
          <PhoneIcon size={15} /> {phone}
        </a>
      )}
      {email && (
        <a className="guardian-contact__link" href={`mailto:${email}`}>
          <MailIcon size={15} /> {email}
        </a>
      )}
      {!phone && !email && <span className="guardian-contact__missing">No guardian contact on file</span>}
      <button type="button" className="linkbtn linkbtn--inline" onClick={() => setEditing(true)}>
        {phone || email ? 'Edit' : 'Add contact'}
      </button>
    </div>
  );
}

/**
 * Guardian contact + log-a-follow-up form for one flagged student. Embedded
 * in StudentProfile and reused from the admin flagged-students view.
 */
export default function FollowUpPanel({ studentId, flag, student, onStudentUpdated }) {
  const { user } = useAuth();
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [method, setMethod] = useState('parent_call');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setHistory(await getFollowUpsForStudent(studentId));
    setLoading(false);
  }, [studentId]);

  useEffect(() => { load(); }, [load]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await addFollowUp({ studentId, flag: flag === 'red' ? 'red' : 'amber', method, note, actorId: user?.username ?? null });
      setNote('');
      await load();
    } catch (err) {
      setError(err.message ?? 'Could not log the follow-up');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2 className="card__title">Follow up</h2>

      {student && (
        <GuardianContact
          studentId={studentId}
          phone={student.guardianPhone}
          email={student.guardianEmail}
          onUpdated={onStudentUpdated}
        />
      )}

      {error && <div className="notice notice--err" role="alert">{error}</div>}

      <form className="followup-form" onSubmit={handleSubmit}>
        <div className="field-row">
          <div className="field" style={{ flex: 1 }}>
            <label className="field__label" htmlFor="fu-method">How</label>
            <select
              id="fu-method" className="field__input" value={method}
              onChange={(e) => setMethod(e.target.value)} disabled={busy}
            >
              {Object.entries(METHOD_LABEL).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="fu-note">Note <span style={{ fontWeight: 400 }}>(optional)</span></label>
          <input
            id="fu-note" className="field__input" type="text" autoComplete="off"
            placeholder="e.g. guardian says student has been unwell" value={note}
            onChange={(e) => setNote(e.target.value)} disabled={busy}
          />
        </div>
        <button className="btn btn--secondary" type="submit" disabled={busy}>
          {busy ? 'Logging…' : 'Log follow-up'}
        </button>
      </form>

      {!loading && history.length > 0 && (
        <div className="followup-history">
          {history.map((h) => (
            <div key={h.followUpId} className="followup-history__row">
              <span className="followup-history__icon"><CheckCircleIcon size={16} /></span>
              <div>
                <div className="followup-history__method">{METHOD_LABEL[h.method] ?? h.method}</div>
                {h.note && <div className="followup-history__note">{h.note}</div>}
                <div className="followup-history__when">{fmtWhen(h.createdAt)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      {!loading && history.length === 0 && (
        <p className="empty" style={{ padding: '8px 0' }}>No follow-up logged yet.</p>
      )}
    </div>
  );
}
