// The Attempts tab of a linked quiz (#200; design docs/superpowers/specs/2026-10-26-linked-quiz-attempts-design.md):
// Prism's version of each attempt, for any mix of MCQs and FRQs. By student walks the class one
// attempt at a time (every attempt stays mounted, so Publish test comments covers the class); By
// question shows one question for every student. FRQ marks publish to the attempt (PostMarksBar);
// test comments publish to the test each student took, through the grade cards' own batch.
import { useEffect, useMemo, useState } from 'react';
import { getQuizAttempts, getMasteryForAssignment, getFeedbackForAssignment, getFeatures, rebuildQuizOverall } from '../../services/api.js';
import { useStickyTab } from '../../hooks/useStickyTab.js';
import { useCardBatch } from '../../hooks/useCardBatch.js';
import { FILTERS } from '../../lib/frqFilters.js';
import AttemptByStudent from './AttemptByStudent.jsx';
import AttemptByQuestion from './AttemptByQuestion.jsx';
import PostMarksBar from './PostMarksBar.jsx';

const VIEWS = [['student', 'By student'], ['question', 'By question']];

export default function AttemptsTab({ group, courseId, reloadKey }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [members, setMembers] = useState({}); // member sid -> { mastery, feedback }
  const [features, setFeatures] = useState({});
  const [view, setView] = useStickyTab('assessment-attempts', 'student', { param: 'view' });
  const [index, setIndex] = useState(0);
  const [frqOnly, setFrqOnly] = useState(false);
  const [filter, setFilter] = useState('all');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setError(null);
    getQuizAttempts(group.id)
      .then(async (d) => {
        if (!active) return;
        setData(d);
        const loaded = await Promise.all(d.group.members.map(async (m) => {
          const [mastery, feedback] = await Promise.all([
            getMasteryForAssignment(courseId, m.schoology_assignment_id),
            getFeedbackForAssignment(m.schoology_assignment_id).catch(() => ({})),
          ]);
          return [m.schoology_assignment_id, { mastery, feedback: feedback || {} }];
        }));
        if (active) setMembers(Object.fromEntries(loaded));
      })
      .catch((e) => { if (active) setError(e.message); });
    Promise.resolve().then(() => getFeatures()).then((f) => { if (active) setFeatures(f || {}); }).catch(() => {});
    return () => { active = false; };
  }, [group.id, courseId, reloadKey, reload]);

  // The cards' rows (each from the member test the student took), and the batch over them.
  const sidByUid = useMemo(() => new Map((data?.students || []).map((s) => [s.schoology_uid, s.member.schoology_assignment_id])), [data]);
  const rows = useMemo(() => Object.values(members).flatMap((m) => m.mastery?.students || []), [members]);
  const patchRow = (uid, patch) => {
    const sid = sidByUid.get(uid);
    setMembers((prev) => (prev[sid] ? {
      ...prev,
      [sid]: { ...prev[sid], mastery: { ...prev[sid].mastery, students: prev[sid].mastery.students.map((s) => (s.schoology_uid === uid ? { ...s, ...patch } : s)) } },
    } : prev));
  };
  const batch = useCardBatch({ courseId, students: rows, onSaved: patchRow });
  const cardBatch = { ...batch, onSaved: patchRow };

  const replaceMark = (studentId, pos, mark) => setData((d) => ({
    ...d,
    students: d.students.map((s) => (s.student_id !== studentId ? s
      : { ...s, responses: { ...s.responses, [pos]: { ...s.responses[pos], mark } } })),
  }));
  const rebuild = async (studentId) => {
    await rebuildQuizOverall(group.id, studentId);
    setReload((k) => k + 1);
  };

  if (error) return <div className="alert alert-warning">{error}</div>;
  if (!data) return <div className="loading">Loading...</div>;

  const { questions, students } = data;
  const hasMcq = questions.some((q) => q.kind === 'mcq');
  const hasFrq = questions.some((q) => q.kind === 'frq');
  // Prism posts only FRQs with a one-row Schoology rubric; others stay with the agent or a paste.
  const countMarks = (statuses, postableOnly = false) => students.reduce((n, s) => n + questions
    .filter((q) => q.kind === 'frq' && (!postableOnly || q.rubric?.rows?.length === 1))
    .filter((q) => statuses.includes(s.responses[q.position]?.mark?.writeback?.status)).length, 0);
  const toPost = countMarks(['pending', 'failed'], true);
  const waiting = countMarks(['pending']);
  const current = Math.min(index, Math.max(students.length - 1, 0));
  const toPublish = Object.values(batch.pendingByUid).filter((v) => v === 'publish').length;

  return (
    <div className="fade-in attempts-tab">
      <div className="subtab-row" role="tablist" aria-label="Attempts view">
        {VIEWS.map(([key, label]) => (
          <button key={key} type="button" role="tab" className={`subtab-btn${view === key ? ' active' : ''}`}
            aria-selected={view === key} onClick={() => setView(key)}>{label}</button>
        ))}
      </div>

      <div className="card attempts-tab__bar">
        {view === 'student' && students.length > 0 && (
          <div className="attempts-tab__walk">
            <button type="button" className="secondary btn-sm" aria-label="Previous student" disabled={current === 0}
              onClick={() => setIndex(current - 1)}>Previous</button>
            <select aria-label="Student" value={current} onChange={(e) => setIndex(Number(e.target.value))}>
              {students.map((s, i) => <option key={s.student_id} value={i}>{s.name}</option>)}
            </select>
            <button type="button" className="secondary btn-sm" aria-label="Next student" disabled={current >= students.length - 1}
              onClick={() => setIndex(current + 1)}>Next</button>
          </div>
        )}
        {view === 'student' && hasMcq && hasFrq && (
          <button type="button" className={`filter-btn${frqOnly ? ' active' : ''}`} aria-pressed={frqOnly}
            onClick={() => setFrqOnly((v) => !v)}>FRQ only</button>
        )}
        {hasFrq && (
          <div role="group" aria-label="FRQ filter" className="attempts-tab__filters">
            {FILTERS.map(([key, label]) => (
              <button key={key} type="button" className={`filter-btn${filter === key ? ' active' : ''}`} aria-pressed={filter === key}
                onClick={() => setFilter(key)}>{label}</button>
            ))}
          </div>
        )}
        {hasFrq && (features.quiz_writeback
          ? <PostMarksBar groupId={group.id} count={toPost} onPosted={() => setReload((k) => k + 1)} />
          : waiting > 0 && <span className="text-sm text-muted">{waiting} waiting for the agent</span>)}
        {view === 'student' && (
          <span className="attempts-tab__publish">
            <button type="button" className="primary btn-sm" disabled={toPublish === 0 || batch.bulkSaving}
              onClick={() => batch.publishAll(() => true)}>
              {batch.bulkSaving ? 'Publishing...' : `Publish test comments (${toPublish})`}
            </button>
            {batch.bulkResult && <span className="text-sm" role="status">{batch.bulkResult}</span>}
          </span>
        )}
      </div>

      {students.length === 0 && <div className="card"><p className="text-muted">No attempts loaded yet: press Load results.</p></div>}

      {/* Every attempt stays mounted, so its test card counts in Publish test comments; one is shown. */}
      {students.map((st, i) => (
        <div key={st.student_id} hidden={view !== 'student' || i !== current}>
          <AttemptByStudent
            st={st} questions={questions} hasTags={data.group.has_tags} showMember={data.group.members.length > 1}
            member={members[st.member.schoology_assignment_id]}
            feedbackRow={members[st.member.schoology_assignment_id]?.feedback?.[st.student_id] || null}
            courseId={courseId} groupId={group.id} frqOnly={frqOnly} filter={filter}
            onRebuild={rebuild} onFrqSaved={replaceMark} batch={cardBatch}
          />
        </div>
      ))}

      {view === 'question' && <AttemptByQuestion data={data} groupId={group.id} filter={filter} onFrqSaved={replaceMark} />}

      {data.not_taken.length > 0 && (
        <p className="text-sm text-muted">{`Not taken (${data.not_taken.length}): ${data.not_taken.map((s) => s.name).join(', ')}`}</p>
      )}
    </div>
  );
}
