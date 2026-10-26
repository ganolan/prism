// By question on the Attempts tab (#200), as Schoology's "view by question": one picker over every
// question, the stem shown once, then every student's answer. An MCQ adds the class's option counts
// and a compact row per student; an FRQ shows one marking card per student, narrowed by the FRQ filter.
import { useState } from 'react';
import { sanitizeStemHtml } from '../../lib/sanitizeHtml.js';
import { matchesFilter, markKey } from '../../lib/frqFilters.js';
import FrqCard from './FrqCard.jsx';
import McqAnswer from './McqAnswer.jsx';

const optionCounts = (q) => (q.options || []).map((o) => `${o.letter} ${o.count}${o.is_key ? ' (answer)' : ''}`).join(', ');

export default function AttemptByQuestion({ data, groupId, filter, onFrqSaved }) {
  const { questions, students } = data;
  const [position, setPosition] = useState(questions[0]?.position ?? null);
  const q = questions.find((x) => x.position === position) ?? questions[0];
  if (!q) return <div className="card"><p className="text-muted">This quiz has no questions loaded.</p></div>;
  return (
    <section className="attempt-by-question" aria-label="By question">
      <div className="attempt-by-question__pick">
        <select className="frq-tab__q" aria-label="Question" value={q.position} onChange={(e) => setPosition(Number(e.target.value))}>
          {questions.map((x) => <option key={x.position} value={x.position}>{`Q${x.position}`}</option>)}
        </select>
        <span className="text-sm text-muted">{q.kind === 'mcq' ? 'Multiple choice' : 'Free response'}</span>
        {q.kind === 'mcq' && q.facility != null && <span className="text-sm text-muted">{`Class ${Math.round(q.facility * 100)}%`} <span className="badge">{q.band}</span></span>}
      </div>
      <div className="card frq-stem" dangerouslySetInnerHTML={{ __html: sanitizeStemHtml(q.stem_html) }} />
      {q.kind === 'mcq' ? (
        <>
          <p className="text-sm">{optionCounts(q)}</p>
          {students.map((st) => <McqAnswer key={st.student_id} question={q} response={st.responses[q.position]} compact name={st.name} />)}
        </>
      ) : students.filter((st) => matchesFilter(st.responses[q.position] || {}, filter)).map((st) => (
        <FrqCard key={`${st.student_id}-${q.position}-${markKey(st.responses[q.position]?.mark)}`}
          groupId={groupId} student={st} question={q} response={st.responses[q.position]}
          onSaved={(mark) => onFrqSaved(st.student_id, q.position, mark)} />
      ))}
    </section>
  );
}
