import { useEffect, useId, useRef, useState } from 'react';
import AnchoredPopover from './AnchoredPopover.jsx';
import { getEmails } from '../../services/api.js';
import { EMAIL_FORMATS, emailText } from '../../lib/emailFormats.js';

// Copy emails (#160) for the students the roster shows: theirs or their guardians', in Class Tools'
// formats. The list comes from Class Tools' own endpoint with the shown students' ids, so the guardian
// rules (do-not-contact and deceased guardians left out, #66) are the same ones.
export default function CopyEmailsPopover({ courseId, studentIds, filtered, anchor, onClose }) {
  const [type, setType] = useState('student');
  const [format, setFormat] = useState('named');
  const [state, setState] = useState({ loading: true });
  const [copied, setCopied] = useState(null); // 'done' | 'failed'
  const box = useRef(null);
  const whoId = useId();
  const formatId = useId();
  const ids = studentIds.join(',');

  useEffect(() => {
    let live = true;
    setState({ loading: true });
    getEmails(courseId, type, '', { students: ids ? ids.split(',').map(Number) : [] })
      .then((result) => { if (live) setState({ result }); })
      .catch((err) => { if (live) setState({ error: err.message }); });
    return () => { live = false; };
  }, [courseId, type, ids]);

  const text = emailText(state.result, format);
  const count = state.result ? (format === 'bare' ? state.result.addresses.length : state.result.count) : 0;
  const n = studentIds.length;

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('done');
      setTimeout(() => setCopied(null), 2000);
    } catch {
      box.current?.select();
      setCopied('failed');
    }
  }

  return (
    <AnchoredPopover anchor={anchor} onClose={onClose} title="Copy emails">
      <p className="text-sm text-muted">
        {filtered ? `The ${n} ${n === 1 ? 'student' : 'students'} the filters show.` : `All ${n} ${n === 1 ? 'student' : 'students'}.`} The same formats as Class Tools.
      </p>
      <div className="roster-pop__field">
        <label htmlFor={whoId}>Whose emails</label>
        <select id={whoId} value={type} onChange={(e) => { setType(e.target.value); setCopied(null); }}>
          <option value="student">Students</option>
          <option value="parent">Guardians</option>
        </select>
      </div>
      <div className="roster-pop__field">
        <label htmlFor={formatId}>Format</label>
        <select id={formatId} value={format} onChange={(e) => { setFormat(e.target.value); setCopied(null); }}>
          {EMAIL_FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
      </div>
      {state.error && <p className="text-sm roster-pop__error">Could not list the emails: {state.error}</p>}
      <textarea ref={box} className="roster-pop__preview" readOnly aria-label="Emails to copy" value={state.loading ? '' : text} rows={4} />
      <div className="roster-pop__actions">
        <button type="button" className="primary btn-sm" disabled={!count} onClick={copy}>
          {copied === 'done' ? 'Copied' : `Copy ${count} ${count === 1 ? 'email' : 'emails'}`}
        </button>
        {type === 'parent' && state.result?.excluded > 0 && (
          <span className="text-sm text-muted">{state.result.excluded === 1 ? '1 guardian not copied' : `${state.result.excluded} guardians not copied`}</span>
        )}
        {copied === 'failed' && <span className="text-sm text-muted">Select the text and copy it.</span>}
      </div>
    </AnchoredPopover>
  );
}
