// Free response tab (spec §12): by question (one picker for every card) or by student.
// Reads Prism's stored copy only; a saved card replaces its mark in place.
import { useEffect, useMemo, useState } from 'react';
import { getFrqResponses, getFeatures } from '../../services/api.js';
import { sanitizeStemHtml } from '../../lib/sanitizeHtml.js';
import FrqCard from './FrqCard.jsx';
import PostMarksBar from './PostMarksBar.jsx';
import { FILTERS, matchesFilter } from '../../lib/frqFilters.js';

export { FILTERS, matchesFilter };

const markKey = (m) => (m ? JSON.stringify([m.state, m.final, m.suggested, m.suggestion_revised]) : 'none');

export default function FreeResponseTab({ groupId, reloadKey }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [features, setFeatures] = useState({});
  const [view, setView] = useState('question');
  const [position, setPosition] = useState(null);
  const [filter, setFilter] = useState('all');
  // Bumped after posting to Schoology, so the cards show the read-back.
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setError(null);
    getFrqResponses(groupId)
      .then(d => { if (!active) return; setData(d); setPosition(p => p ?? d.questions[0]?.position ?? null); })
      .catch(e => { if (active) setError(e.message); });
    Promise.resolve().then(() => getFeatures()).then(f => { if (active) setFeatures(f || {}); }).catch(() => {});
    return () => { active = false; };
  }, [groupId, reloadKey, reload]);

  // Prism posts only FRQs with a one-row Schoology rubric; others stay with the agent or a paste.
  const countMarks = (statuses, postableOnly = false) => (data ? data.students.reduce((n, s) =>
    n + data.questions.filter(q => !postableOnly || q.rubric?.rows?.length === 1)
      .filter(q => statuses.includes(s.responses[q.position]?.mark?.writeback?.status)).length, 0) : 0);
  const waiting = useMemo(() => countMarks(['pending']), [data]);
  const toPost = useMemo(() => countMarks(['pending', 'failed'], true), [data]);

  if (error) return <div className="alert alert-warning">{error}</div>;
  if (!data) return <div className="loading">Loading...</div>;
  if (!data.questions.length) return <div className="card"><p className="text-muted">This quiz has no free-response questions.</p></div>;
  if (!data.students.length) return <div className="card"><p className="text-muted">No results loaded yet. Use Load results above.</p></div>;

  const replaceMark = (studentId, pos, mark) => setData(d => ({
    ...d,
    students: d.students.map(s => (s.student_id !== studentId ? s
      : { ...s, responses: { ...s.responses, [pos]: { ...s.responses[pos], mark } } })),
  }));
  const card = (s, q) => (
    // Keyed by the mark's content, so a saved change (even one that keeps the state) restarts the card from it.
    <FrqCard key={`${s.student_id}-${q.position}-${markKey(s.responses[q.position].mark)}`}
      groupId={groupId} student={s} question={q} response={s.responses[q.position]}
      onSaved={(m) => replaceMark(s.student_id, q.position, m)} />
  );
  const question = data.questions.find(q => q.position === position) ?? data.questions[0];

  return (
    <div className="fade-in frq-tab">
      {/* Free response's child row (#194), first in the panel its tab joins. */}
      <div className="subtab-row" role="tablist" aria-label="View">
        <button type="button" role="tab" className={`subtab-btn${view === 'question' ? ' active' : ''}`} aria-selected={view === 'question'} onClick={() => setView('question')}>By question</button>
        <button type="button" role="tab" className={`subtab-btn${view === 'student' ? ' active' : ''}`} aria-selected={view === 'student'} onClick={() => setView('student')}>By student</button>
      </div>
      <div className="card frq-tab__bar">
        {view === 'question' && (
          <select className="frq-tab__q" aria-label="Question" value={question.position} onChange={(e) => setPosition(Number(e.target.value))}>
            {data.questions.map(q => <option key={q.position} value={q.position}>{`Q${q.position}`}</option>)}
          </select>
        )}
        <div role="group" aria-label="Filter" style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
          {FILTERS.map(([key, label]) => (
            <button key={key} type="button" className={`filter-btn${filter === key ? ' active' : ''}`} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>
          ))}
        </div>
        {features.quiz_writeback
          ? <PostMarksBar groupId={groupId} count={toPost} onPosted={() => setReload(k => k + 1)} />
          : waiting > 0 && <span className="text-sm text-muted">{waiting} waiting for the agent</span>}
      </div>

      {view === 'question' ? (
        <>
          <div className="card frq-stem" dangerouslySetInnerHTML={{ __html: sanitizeStemHtml(question.stem_html) }} />
          {data.students.filter(s => matchesFilter(s.responses[question.position], filter)).map(s => card(s, question))}
        </>
      ) : (
        data.students
          .filter(s => data.questions.some(q => matchesFilter(s.responses[q.position], filter)))
          .map(s => (
            <section key={s.student_id} className="frq-student">
              {data.questions.filter(q => matchesFilter(s.responses[q.position], filter)).map(q => (
                <div key={q.position}>
                  <h3 className="frq-student__q">{`Q${q.position}`}</h3>
                  {card(s, q)}
                </div>
              ))}
            </section>
          ))
      )}
    </div>
  );
}
