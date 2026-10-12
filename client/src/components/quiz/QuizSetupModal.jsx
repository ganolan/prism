// Combine tests into a quiz group and link it to an aligned result task
// (docs/superpowers/specs/2026-10-12-linked-quiz-results-design.md §8). Prism
// suggests tests with similar titles; the teacher confirms every combine, and a
// parity check of the ticked tests must pass first.
import { useEffect, useState } from 'react';
import { getQuizCandidates, checkQuizParity, createQuizGroup, linkQuizResult, deleteQuizGroup } from '../../services/api.js';

export default function QuizSetupModal({ open, courseId, currentAssignment, group, onClose, onChanged }) {
  const [candidates, setCandidates] = useState(null);
  const [ticked, setTicked] = useState([]);
  const [title, setTitle] = useState('');
  const [parity, setParity] = useState(null); // { ok, differences, forKey }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // null = show the saved link; a string is the teacher's pick ('' = Not linked).
  const [resultId, setResultId] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const currentId = currentAssignment?.schoology_assignment_id;
  const linkedId = group?.result?.schoology_assignment_id || '';

  useEffect(() => {
    if (!open) return undefined;
    let stale = false;
    setCandidates(null); setTicked([]); setParity(null); setError(null); setConfirmRemove(false);
    setTitle(currentAssignment?.title || ''); setResultId(null);
    getQuizCandidates(courseId).then((c) => {
      if (stale) return; // a newer open or course superseded this response
      setCandidates(c);
      const me = c.tests.find(t => t.schoology_assignment_id === currentId);
      setTicked(me ? [me.schoology_assignment_id, ...me.suggestedWith] : []);
    }).catch((e) => { if (!stale) setError(e.message); });
    return () => { stale = true; };
  }, [open, courseId, currentId]); // eslint-disable-line react-hooks/exhaustive-deps -- reset on open only; currentAssignment.title is read at open

  // A different saved link means an earlier pick no longer applies.
  useEffect(() => { setResultId(null); }, [linkedId]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const key = [...ticked].sort().join(',');
  const canCombine = ticked.length === 1 || (parity?.ok && parity.forKey === key);
  const selected = resultId ?? linkedId;
  const canLink = !busy && selected !== '' && selected !== linkedId;
  // The linked summative is already listed first; skip it so it appears once.
  const summatives = (candidates?.summatives || []).filter(s => s.schoology_assignment_id !== linkedId);

  async function run(fn) {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function combine() {
    setBusy(true); setError(null);
    try {
      const r = await createQuizGroup({ courseId, assignmentIds: ticked, title: title.trim() });
      onChanged(r.group);
    } catch (e) {
      // A create-time 409 carries the same differences as the check, so show them too.
      if (e.differences?.length) setParity({ ok: false, differences: e.differences, forKey: key });
      setError(e.message);
    } finally { setBusy(false); }
  }

  // Any change to the ticks drops the previous check, even if the set returns to one already checked.
  const toggle = (sid) => { setParity(null); setTicked(t => (t.includes(sid) ? t.filter(x => x !== sid) : [...t, sid])); };

  return (
    <div role="dialog" aria-modal="true" aria-label="Quiz setup" className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ width: 'min(560px, 90vw)' }}>
        <h3 style={{ marginTop: 0 }}>Quiz setup</h3>
        {error && <div className="alert alert-warning">{error}</div>}

        {!group && candidates && (
          <>
            <p className="text-sm text-muted">Tick the tests to treat as one quiz, for example a standard and an extra-time copy.</p>
            {candidates.tests.map(t => (
              <label key={t.schoology_assignment_id} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', padding: '0.2rem 0' }}>
                <input type="checkbox" checked={ticked.includes(t.schoology_assignment_id)} onChange={() => toggle(t.schoology_assignment_id)} aria-label={t.title} />
                {t.title}
              </label>
            ))}
            <label className="text-sm" style={{ display: 'block', marginTop: '0.75rem' }}>
              Quiz name <input value={title} onChange={(e) => setTitle(e.target.value)} style={{ width: '100%' }} />
            </label>
            {ticked.length > 1 && (
              <button className="secondary" disabled={busy} style={{ marginTop: '0.75rem' }}
                onClick={() => run(async () => setParity({ ...(await checkQuizParity(ticked)), forKey: key }))}>
                Check questions
              </button>
            )}
            {parity && parity.forKey === key && (parity.ok
              ? <div className="alert alert-success" style={{ marginTop: '0.5rem' }}>Same questions</div>
              : (
                <div className="alert alert-warning" style={{ marginTop: '0.5rem' }}>
                  These tests have different questions, so they cannot be combined.
                  {parity.differences.map(d => (
                    <div key={d.assignmentId} style={{ marginTop: '0.4rem' }}>
                      <strong>{d.title}</strong>
                      {d.missing.map((m, i) => <div key={`m${i}`}>Missing: {m}</div>)}
                      {d.extra.map((x, i) => <div key={`x${i}`}>Extra: {x}</div>)}
                    </div>
                  ))}
                </div>
              ))}
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
              <button className="primary" disabled={busy || !canCombine || !ticked.length} onClick={combine}>
                Combine
              </button>
              <button className="ghost" onClick={onClose}>Cancel</button>
            </div>
          </>
        )}

        {group && (
          <>
            <p className="text-sm"><strong>{group.title}</strong>: {group.members.map(m => m.title).join(', ')}</p>
            <label className="text-sm" style={{ display: 'block' }}>
              Result task{' '}
              <select aria-label="Result task" value={selected} onChange={(e) => setResultId(e.target.value)}>
                <option value="">Not linked</option>
                {group.result && <option value={group.result.schoology_assignment_id}>{group.result.title}</option>}
                {summatives.map(s => <option key={s.schoology_assignment_id} value={s.schoology_assignment_id}>{s.title}</option>)}
              </select>
            </label>
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
              <button className="primary" disabled={!canLink}
                onClick={() => run(async () => onChanged((await linkQuizResult(group.id, selected)).group))}>Link</button>
              {group.result && (
                <button className="secondary" disabled={busy}
                  onClick={() => run(async () => { onChanged((await linkQuizResult(group.id, null)).group); setResultId(''); })}>Unlink</button>
              )}
              {!confirmRemove
                ? <button className="ghost danger" onClick={() => setConfirmRemove(true)}>Remove quiz group</button>
                : (
                  <span className="text-sm">
                    Remove the quiz group? Loaded results are removed; Schoology is not changed.{' '}
                    <button className="ghost danger" disabled={busy}
                      onClick={() => run(async () => { await deleteQuizGroup(group.id); onChanged(null); })}>Remove</button>
                  </span>
                )}
              <button className="ghost" onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
