// Post accepted FRQ marks to Schoology (spec §14): one student first, then the rest, each read back.
// The rest is offered only after a first mark has posted, so a refused first post never opens the batch.
// Shown only while quiz_writeback is on.
import { useState } from 'react';
import { postFrqWritebacks } from '../../services/api.js';

const line = (r) => {
  if (r.status === 'posted') return `Posted: ${r.name}, Q${r.question} ${r.level}`;
  return `${r.status === 'skipped' ? 'Skipped' : 'Failed'}: ${r.name}, Q${r.question}: ${r.error}`;
};

export default function PostMarksBar({ groupId, count, onPosted }) {
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null); // null before the first post
  const [remaining, setRemaining] = useState(0);
  const [error, setError] = useState(null);
  if (!count && !results) return null;
  const onePosted = !!results?.some(r => r.status === 'posted');

  async function post(limit) {
    setBusy(true); setError(null);
    try {
      const r = await postFrqWritebacks(groupId, limit);
      setResults(prev => [...(prev || []), ...r.results]);
      setRemaining(r.remaining);
    } catch (e) { setError(e.message); } finally { setBusy(false); onPosted(); }
  }

  return (
    <div className="post-marks">
      {!results && (
        <button className="primary" disabled={busy} onClick={() => post(1)}>{`Post accepted to Schoology (${count})`}</button>
      )}
      {results && (
        <>
          <ul className="post-marks__results">
            {results.map((r, i) => <li key={i} className={r.status === 'posted' ? 'post-marks__ok' : 'post-marks__fail'}>{line(r)}</li>)}
          </ul>
          {onePosted && results.length === 1 && <p className="text-sm text-muted">Check it in Schoology before posting the rest.</p>}
          {remaining > 0 && (onePosted
            ? <button className="secondary" disabled={busy} onClick={() => post(null)}>{`Post the remaining ${remaining}`}</button>
            : <button className="secondary" disabled={busy} onClick={() => post(1)}>Post one more first</button>)}
        </>
      )}
      {busy && <span className="text-sm text-muted">Posting...</span>}
      {error && <div className="alert alert-warning">{error}</div>}
    </div>
  );
}
