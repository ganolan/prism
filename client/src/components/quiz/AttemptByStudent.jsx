// One student's whole attempt on the Attempts tab (#200): a header (the student, the member test they
// took when the group has several, the attempt link, the time taken), the test's own grade card (score,
// overall comment with the template suggestion, the quiz line and Update numbers), the percent by tag
// when the quiz has tags, then every question in order: an MCQ row or the FRQ marking card.
import StudentRubricCard from '../gradeCard/StudentRubricCard.jsx';
import AttemptLink from './AttemptLink.jsx';
import FrqCard from './FrqCard.jsx';
import McqAnswer from './McqAnswer.jsx';
import { matchesFilter, markKey } from '../../lib/frqFilters.js';

// Minutes between two stored times ('YYYY-MM-DD HH:MM:SS', UTC). → "35 min", "1 h 5 min", or null.
export function timeTaken(startedAt, completedAt) {
  if (!startedAt || !completedAt) return null;
  const t = (s) => Date.parse(/[TZ]/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  const min = Math.round((t(completedAt) - t(startedAt)) / 60000);
  if (!Number.isFinite(min) || min < 0) return null;
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

export default function AttemptByStudent({
  st, questions, hasTags, showMember, member, feedbackRow, courseId, groupId,
  frqOnly, filter, onRebuild, onFrqSaved, batch,
}) {
  const taken = timeTaken(st.started_at, st.completed_at);
  const row = member?.mastery?.students?.find((s) => s.id === st.student_id) || null;
  const shown = questions.filter((q) => (q.kind === 'frq' ? matchesFilter(st.responses[q.position] || {}, filter) : !frqOnly));
  return (
    <section className="attempt" aria-label={`${st.name}'s attempt`}>
      <header className="attempt__head">
        <h3 className="attempt__name">{st.name}</h3>
        {showMember && <span className="badge">{st.member.title}</span>}
        <AttemptLink link={{ url: st.attempt_url, completedAt: st.completed_at }} name={st.name} />
        {taken && <span className="text-sm text-muted">{taken}</span>}
      </header>
      {row && member && (
        <StudentRubricCard
          student={row}
          topics={member.mastery.topics || []}
          courseId={courseId}
          assignmentId={st.member.schoology_assignment_id}
          assignmentRow={member.mastery.assignment}
          feedbackRow={feedbackRow}
          scoreScale={member.mastery.scoreScale || null}
          quizResult={st}
          onRebuildQuiz={onRebuild}
          resubmitEnabled={false}
          onSaved={batch.onSaved}
          onPendingChange={batch.onPendingChange}
          onDisplayChange={batch.onDisplayChange}
          registerCard={batch.registerCard}
          unregisterCard={batch.unregisterCard}
        />
      )}
      {hasTags && st.by_tag?.length > 0 && (
        <p className="text-sm attempt__tags">{st.by_tag.map((t) => `${t.tag}: ${t.percent}%`).map((t) => <span key={t}>{t}</span>)}</p>
      )}
      <div className="attempt__questions">
        {shown.map((q) => (q.kind === 'mcq'
          ? <McqAnswer key={q.position} question={q} response={st.responses[q.position]} />
          : (
            <div key={q.position} className="attempt__frq">
              <h4 className="frq-student__q">{`Q${q.position}`}</h4>
              <FrqCard key={markKey(st.responses[q.position]?.mark)} groupId={groupId} student={st} question={q} response={st.responses[q.position]} showStudent={false}
                onSaved={(mark) => onFrqSaved(st.student_id, q.position, mark)} />
            </div>
          )))}
      </div>
    </section>
  );
}
