// The Attempts tab's read model (#200): every question of a quiz group and every student's answers,
// for any mix of MCQs and FRQs. Each student is their quiz results row (the member test taken, score,
// times, MCQ score, FRQ levels, readiness, the overall suggestion) with `responses` keyed by question
// position. Built only from Prism's stored copy; nothing here reads Schoology.
import { getGroup } from './quizGroups.js';
import { groupStats } from './quizStats.js';
import { quizResults } from './quizResults.js';
import { frqResponses } from './frqResponses.js';

const parse = (t, fallback = null) => (t ? JSON.parse(t) : fallback);

export function quizAttempts(db, { groupId }) {
  const group = getGroup(db, groupId);
  const rows = db.prepare('SELECT * FROM quiz_questions WHERE group_id = ? ORDER BY position').all(group.id);
  const stats = new Map(groupStats(db, { groupId: group.id }).questions.map(q => [q.position, q]));
  const questions = rows.map((q) => {
    const s = stats.get(q.position);
    const base = { id: q.id, position: q.position, kind: q.kind, stem_html: q.stem_html, max_points: q.max_points, tags: s.tags };
    if (q.kind === 'mcq') return { ...base, options: s.options, facility: s.facility, band: s.band };
    if (q.kind === 'frq') return { ...base, rubric: parse(q.schoology_rubric_json) };
    return base;
  });
  const keyOf = new Map(questions.filter(q => q.kind === 'mcq')
    .map(q => [q.id, (q.options || []).find(o => o.is_key)?.letter ?? null]));

  const results = quizResults(db, { groupId: group.id });
  const frq = new Map(frqResponses(db, { groupId: group.id }).students.map(s => [s.attempt_id, s.responses]));
  const responsesQ = db.prepare('SELECT * FROM quiz_responses WHERE attempt_id = ?');
  const students = results.students.map((st) => {
    const stored = new Map(responsesQ.all(st.attempt_id).map(r => [r.question_id, r]));
    const responses = {};
    for (const q of questions) {
      if (q.kind === 'mcq') {
        const r = stored.get(q.id);
        responses[q.position] = {
          kind: 'mcq', chosen_letter: r?.chosen_letter ?? null, key_letter: keyOf.get(q.id),
          is_correct: r?.is_correct === 1, points: r?.points ?? null, max_points: r?.max_points ?? q.max_points,
        };
      } else if (q.kind === 'frq') {
        responses[q.position] = { kind: 'frq', ...(frq.get(st.attempt_id)?.[q.position] ?? { answer_html: null, schoology: null, mark: null }) };
      }
    }
    return { ...st, responses };
  });

  return {
    group: {
      id: group.id, title: group.title, members: group.members,
      has_tags: questions.some(q => (q.tags || []).length > 0),
    },
    questions,
    students,
    not_taken: results.not_taken,
  };
}
