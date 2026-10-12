// Per-question statistics for a quiz group (spec §8). Counts, percentages, bands
// and distractor flags only; no discrimination statistics.
import { useEffect, useMemo, useState } from 'react';
import { getQuizStats, setQuizTags } from '../../services/api.js';

// Stem and option HTML is the teacher's own Schoology question text, rendered as-is in this local app.
// DOMParser is inert (no scripts, no image loads), so reading textContent here runs nothing.
const plain = (html) => new DOMParser().parseFromString(html || '', 'text/html').body.textContent.replace(/\s+/g, ' ').trim();
const FLAG_CLASS = { critical: 'badge badge-red', warning: 'badge badge-amber', note: 'badge' };

function QuestionRow({ q, groupId, onTagsSaved }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(q.tags.join(', '));
  const [saveError, setSaveError] = useState(null);
  const stemText = useMemo(() => plain(q.stem_html).slice(0, 120), [q.stem_html]);
  const pct = q.facility == null ? null : Math.round(q.facility * 100);
  async function saveTags() {
    const tags = draft.split(',').map(t => t.trim()).filter(Boolean);
    try {
      await setQuizTags(groupId, { [q.position]: tags });
    } catch (e) {
      setSaveError(e.message);
      return;
    }
    setSaveError(null);
    setEditing(false);
    onTagsSaved();
  }
  return (
    <div data-testid="question-row" data-position={q.position} style={{ padding: '0.6rem 1rem', borderBottom: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="ghost" aria-expanded={open} onClick={() => setOpen(o => !o)} style={{ fontWeight: 700 }}>Q{q.position}</button>
        <span className="text-sm text-muted">{q.kind === 'mcq' ? 'MCQ' : q.kind === 'frq' ? 'FRQ' : 'Other'}</span>
        {q.tags.map(t => <span key={t} className="badge">{t}</span>)}
        {!editing && <button className="ghost" onClick={() => { setDraft(q.tags.join(', ')); setSaveError(null); setEditing(true); }} style={{ fontSize: '0.75rem' }}>Edit tags</button>}
        {editing && (
          <>
            <input type="text" aria-label={`Tags for question ${q.position}`} value={draft} onChange={(e) => setDraft(e.target.value)} style={{ width: 220, maxWidth: '100%' }} />
            <button className="secondary" onClick={saveTags}>Save tags</button>
          </>
        )}
        <span className="text-sm" style={{ flex: 1, minWidth: 160 }}>{stemText}</span>
        {pct != null && (
          <>
            <span aria-hidden="true" style={{ width: 90, height: 8, borderRadius: 4, background: 'var(--bg-subtle)', overflow: 'hidden', display: 'inline-block' }}>
              <span style={{ display: 'block', height: '100%', width: `${pct}%`, background: 'var(--accent)' }} />
            </span>
            <span className="text-sm">{pct}%</span>
            <span className="badge">{q.band}</span>
          </>
        )}
      </div>
      {saveError && <div className="alert alert-warning" style={{ marginTop: '0.4rem' }}>{saveError}</div>}
      {q.options.length > 0 && (
        <div className="text-sm" style={{ display: 'flex', gap: '0.9rem', marginTop: '0.3rem', marginLeft: '2.5rem' }}>
          {q.options.map(o => <span key={o.letter} style={o.is_key ? { fontWeight: 700 } : undefined}>{`${o.letter} ${o.count}${o.is_key ? ' ✓' : ''}`}</span>)}
        </div>
      )}
      {q.flags.length > 0 && (
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.3rem', marginLeft: '2.5rem' }}>
          {q.flags.map(f => <span key={f.text} className={FLAG_CLASS[f.level]}>{f.text}</span>)}
        </div>
      )}
      {open && (
        <div style={{ marginTop: '0.5rem', marginLeft: '2.5rem', maxWidth: 'calc(100% - 2.5rem)', overflowX: 'auto' }}>
          <div style={{ maxWidth: '100%' }} dangerouslySetInnerHTML={{ __html: q.stem_html }} />
          {q.options.map(o => (
            <div key={o.letter} style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', maxWidth: '100%' }}>
              <strong>{o.letter}</strong><span dangerouslySetInnerHTML={{ __html: o.html }} /><span className="text-muted">{o.count}{o.is_key ? ' ✓' : ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function QuestionsTab({ groupId, reloadKey }) {
  // Stats are tagged with the group they belong to, so another group never shows them while its own load runs.
  const [loaded, setLoaded] = useState({ groupId: null, stats: null });
  const stats = loaded.groupId === groupId ? loaded.stats : null;
  const [error, setError] = useState(null);
  const [lowestFirst, setLowestFirst] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    setError(null);
    getQuizStats(groupId).then(s => { if (active) setLoaded({ groupId, stats: s }); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [groupId, reloadKey, version]);

  if (error) return <div className="alert alert-warning">{error}</div>;
  if (!stats) return <div className="loading">Loading...</div>;
  if (!stats.takers) return <div className="card"><p className="text-muted">No results loaded yet. Use Load results above.</p></div>;

  const questions = [...stats.questions];
  if (lowestFirst) {
    questions.sort((a, b) => (a.facility ?? 2) - (b.facility ?? 2) || a.position - b.position);
  }
  const split = stats.byMember.length > 1 ? ` (${stats.byMember.map(m => `${m.title} ${m.takers}`).join(', ')})` : '';

  return (
    <div className="fade-in">
      <div className="card">
        <p style={{ margin: 0 }}>
          Takers {stats.takers} of {stats.classSize}{split}
          {stats.mcq.median_percent != null && <span>, MCQ median {stats.mcq.median_percent}%</span>}
        </p>
        <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap', marginTop: '0.75rem' }}>
          {stats.byTag.length > 0 && (
            <table aria-label="By tag" className="text-sm">
              <thead><tr><th>Tag</th><th>Questions</th><th>Correct</th><th>%</th></tr></thead>
              <tbody>{stats.byTag.map(t => (
                <tr key={t.tag}><td>{t.tag}</td><td>{t.positions.map(p => `Q${p}`).join(' ')}</td><td>{t.correct}/{t.total}</td><td>{t.percent}%</td></tr>
              ))}</tbody>
            </table>
          )}
          <table aria-label="By type" className="text-sm">
            <thead><tr><th>Type</th><th>Result</th></tr></thead>
            <tbody>
              {stats.mcq.count > 0 && <tr><td>MCQ ({stats.mcq.count})</td><td>{stats.mcq.median_percent != null && `median ${stats.mcq.median_percent}%`}</td></tr>}
              {stats.frq.count > 0 && <tr><td>FRQ ({stats.frq.count})</td><td>{stats.frq.levels.map(l => `${l.name} ${l.count}`).join(', ')}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid var(--border)' }}>
          <button className={`filter-btn${lowestFirst ? ' active' : ''}`} onClick={() => setLowestFirst(v => !v)}>Lowest first</button>
        </div>
        {questions.map(q => <QuestionRow key={q.position} q={q} groupId={groupId} onTagsSaved={() => setVersion(v => v + 1)} />)}
      </div>
    </div>
  );
}
