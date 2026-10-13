// Publish accepted FRQ marks to Schoology (spec §14, §15): one click writes every accepted mark on every
// free-response question of the quiz, each read back, with a line per student. Teachers usually keep
// questions (and so feedback) hidden from students until they release it, so there is no one-first step;
// a mark that fails stays waiting and the button comes back for it. Shown only while quiz_writeback is on.
import { useState } from 'react';
import { postFrqWritebacks } from '../../services/api.js';

const line = (r) => {
  if (r.status === 'posted') return `Published: ${r.name}, Q${r.question} ${r.level}`;
  return `${r.status === 'skipped' ? 'Skipped' : 'Failed'}: ${r.name}, Q${r.question}: ${r.error}`;
};

export default function PostMarksBar({ groupId, count, onPosted }) {
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null); // null before the first publish
  const [remaining, setRemaining] = useState(0);
  const [error, setError] = useState(null);
  const toPublish = results ? remaining : count;
  if (!toPublish && !results) return null;

  async function publish() {
    setBusy(true); setError(null);
    try {
      const r = await postFrqWritebacks(groupId, null);
      setResults(prev => [...(prev || []), ...r.results]);
      setRemaining(r.remaining);
    } catch (e) { setError(e.message); } finally { setBusy(false); onPosted(); }
  }

  return (
    <div className="post-marks">
      {toPublish > 0 && (
        <>
          <button className="primary" disabled={busy} onClick={publish}>{`Publish all to Schoology (${toPublish})`}</button>
          {/* Prism saves through the question's grade-by-question form (spec §15): that page, left open and saved later, sends its old values back. */}
          <p className="text-sm text-muted">Close any grade-by-question page for this quiz in Schoology first: saving it later would undo these marks.</p>
        </>
      )}
      {results && (
        <ul className="post-marks__results">
          {results.map((r, i) => <li key={i} className={r.status === 'posted' ? 'post-marks__ok' : 'post-marks__fail'}>{line(r)}</li>)}
        </ul>
      )}
      {busy && <span className="text-sm text-muted">Publishing...</span>}
      {error && <div className="alert alert-warning">{error}</div>}
    </div>
  );
}
