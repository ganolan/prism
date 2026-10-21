// The overall result on a quiz's linked result task (spec §13): an ordinary suggestion whose
// comment Prism builds from the group's template. The agent supplies levels and an impression;
// Prism refuses a student whose FRQ marks are not confirmed yet.
import { QuizError } from './quizError.js';
import { quizResults } from './quizResults.js';
import { resolveStudentId } from './idResolvers.js';
import { upsertStudentSuggestion } from './suggestions.js';
import { buildComment } from '../lib/quizComment.js';

function eligibleResults(db, groupId) {
  const data = quizResults(db, { groupId });
  if (!data.group.result) throw new QuizError('NOT_ELIGIBLE', 'Link this quiz group to its result task first');
  if (!data.group.loaded_at) throw new QuizError('NOT_ELIGIBLE', 'Load the results first');
  return data;
}

function store(db, data, st, fields) {
  const narrative = buildComment(data.group.template, { ...st.comment_values, impression: fields.quiz_overall.impression });
  return upsertStudentSuggestion(db, {
    ...fields,
    assignmentId: data.group.result.schoology_assignment_id,
    student: st.student_id,
    narrative_feedback: narrative,
    quiz_overall: { group_id: fields.quiz_overall.group_id, impression: fields.quiz_overall.impression, built: narrative },
  });
}

export function writeOverallSuggestions(db, { groupId, students }) {
  const data = eligibleResults(db, groupId);
  const results = (students || []).map((s) => {
    const fail = (message) => ({ student: s.student, status: 'error', message });
    const studentId = resolveStudentId(db, s.student);
    if (!studentId) return fail(`Student not found: ${s.student}`);
    const st = data.students.find(x => x.student_id === studentId);
    if (!st) return fail('No attempt on this quiz');
    if (!st.ready) return fail(`Not ready: ${st.blocked.join(', ')}`);
    const impression = String(s.impression ?? '').trim();
    if (!impression) return fail('impression is required');
    const r = store(db, data, st, {
      rubric_scores: s.rubric_scores, reviewer_flags: s.reviewer_flags, reviewer_flags_brief: s.reviewer_flags_brief,
      quiz_overall: { group_id: data.group.id, impression },
    });
    return { ...r, student: s.student };
  });
  return { written: results.filter(r => r.status === 'written').length, results };
}

// Update numbers: the same suggestion with the current numbers and template.
export function rebuildOverallSuggestion(db, { groupId, studentId }) {
  const data = eligibleResults(db, groupId);
  const st = data.students.find(x => x.student_id === Number(studentId));
  if (!st) throw new QuizError('NOT_FOUND', 'No attempt on this quiz for that student');
  if (!st.overall) throw new QuizError('NOT_ELIGIBLE', 'There is no overall suggestion to update');
  if (!st.ready) throw new QuizError('NOT_ELIGIBLE', `Not ready: ${st.blocked.join(', ')}`);
  if (st.overall.edited) throw new QuizError('NOT_ELIGIBLE', 'The comment was edited: write the overall result again to update it');
  const fj = JSON.parse(db.prepare('SELECT feedback_json FROM feedback WHERE id = ?').get(st.overall.feedback_id).feedback_json);
  store(db, data, st, {
    rubric_scores: fj.rubric_scores, reviewer_flags: fj.reviewer_flags, reviewer_flags_brief: fj.reviewer_flags_brief,
    strengths: fj.strengths, suggestions: fj.suggestions, scale_level: fj.scale_level, evidence: fj.evidence,
    quiz_overall: fj.quiz_overall,
  });
  return quizResults(db, { groupId }).students.find(x => x.student_id === st.student_id);
}
