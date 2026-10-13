// Free response tab (spec §12): by question (one picker for every card) or by student.
// Reads Prism's stored copy only; a saved card replaces its mark in place.
import { useEffect, useMemo, useState } from 'react';
import { getFrqResponses, getFeatures } from '../../services/api.js';
import { sanitizeAnswerHtml } from '../../lib/sanitizeHtml.js';
import FrqCard from './FrqCard.jsx';

export const FILTERS = [
  ['all', 'All'], ['review', 'To review'], ['accepted', 'Accepted'], ['waiting', 'Waiting to post'],
  ['posted', 'Posted'], ['failed', 'Failed'], ['changed', 'Changed in Schoology'],
];

export function matchesFilter(response, key) {
  const m = response.mark;
  switch (key) {
    case 'review': return m ? m.state === 'suggested' || m.suggestion_revised : !response.schoology;
    case 'accepted': return !!m && (m.state === 'accepted' || m.state === 'edited');
    case 'waiting': return m?.writeback?.status === 'pending';
    case 'posted': return m?.writeback?.status === 'posted' && !m.changed_in_schoology;
    case 'failed': return m?.writeback?.status === 'failed';
    case 'changed': return !!m?.changed_in_schoology;
    default: return true;
  }
}

export default function FreeResponseTab({ groupId, reloadKey }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [features, setFeatures] = useState({});
  const [view, setView] = useState('question');
  const [position, setPosition] = useState(null);
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    let active = true;
    setError(null);
    getFrqResponses(groupId)
      .then(d => { if (!active) return; setData(d); setPosition(p => p ?? d.questions[0]?.position ?? null); })
      .catch(e => { if (active) setError(e.message); });
    Promise.resolve().then(() => getFeatures()).then(f => { if (active) setFeatures(f || {}); }).catch(() => {});
    return () => { active = false; };
  }, [groupId, reloadKey]);

  const waiting = useMemo(() => (data ? data.students.reduce((n, s) =>
    n + Object.values(s.responses).filter(r => r.mark?.writeback?.status === 'pending').length, 0) : 0), [data]);

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
    <FrqCard key={`${s.student_id}-${q.position}-${s.responses[q.position].mark?.state ?? 'none'}`}
      groupId={groupId} student={s} question={q} response={s.responses[q.position]}
      onSaved={(m) => replaceMark(s.student_id, q.position, m)} />
  );
  const question = data.questions.find(q => q.position === position) ?? data.questions[0];

  return (
    <div className="fade-in frq-tab">
      <div className="card frq-tab__bar">
        <div role="group" aria-label="View" style={{ display: 'flex', gap: '0.25rem' }}>
          <button type="button" className={`filter-btn${view === 'question' ? ' active' : ''}`} aria-pressed={view === 'question'} onClick={() => setView('question')}>By question</button>
          <button type="button" className={`filter-btn${view === 'student' ? ' active' : ''}`} aria-pressed={view === 'student'} onClick={() => setView('student')}>By student</button>
        </div>
        {view === 'question' && (
          <select aria-label="Question" value={question.position} onChange={(e) => setPosition(Number(e.target.value))}>
            {data.questions.map(q => <option key={q.position} value={q.position}>{`Q${q.position}`}</option>)}
          </select>
        )}
        <div role="group" aria-label="Filter" style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
          {FILTERS.map(([key, label]) => (
            <button key={key} type="button" className={`filter-btn${filter === key ? ' active' : ''}`} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>
          ))}
        </div>
        {!features.quiz_writeback && waiting > 0 && <span className="text-sm text-muted">{waiting} waiting for the agent</span>}
      </div>

      {view === 'question' ? (
        <>
          <div className="card frq-stem" dangerouslySetInnerHTML={{ __html: sanitizeAnswerHtml(question.stem_html) }} />
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
