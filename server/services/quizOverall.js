// The overall result of a quiz (spec §13, #200), written in parts for teacher review. The impression
// becomes the test comment: an ordinary suggestion on the member test the student took, whose comment
// Prism builds from the group's template. The levels and the optional narrative (the teacher's guidance
// to revise and improve) go on the linked result task. Each part is written only when the call carries
// it, and a result-task write keeps the other half of that task's latest suggestion. The test comment
// and the levels rest on the FRQ marks, so they wait until every FRQ is confirmed; the narrative does not.
import { QuizError } from './quizError.js';
import { quizResults } from './quizResults.js';
import { resolveStudentId } from './idResolvers.js';
import { upsertStudentSuggestion } from './suggestions.js';
import { buildComment } from '../lib/quizComment.js';

const parse = (t, fallback = null) => (t ? JSON.parse(t) : fallback);
const hasLevels = (scores) => !!scores && Object.keys(scores).length > 0;

function loadedResults(db, groupId) {
  const data = quizResults(db, { groupId });
  if (!data.group.loaded_at) throw new QuizError('NOT_ELIGIBLE', 'Load the results first');
  return data;
}

// The test comment on the member test the student took.
function storeTest(db, data, st, fields) {
  const narrative = buildComment(data.group.template, { ...st.comment_values, impression: fields.quiz_overall.impression });
  return upsertStudentSuggestion(db, {
    ...fields,
    assignmentId: st.member.schoology_assignment_id,
    student: st.student_id,
    narrative_feedback: narrative,
    quiz_overall: { group_id: fields.quiz_overall.group_id, impression: fields.quiz_overall.impression, built: narrative },
  });
}

// The levels and the narrative on the result task, merged with its latest suggestion so a later call
// with only one of them keeps the other.
function storeResult(db, data, st, { rubric_scores, narrative, reviewer_flags, reviewer_flags_brief }) {
  const result = data.group.result;
  const latest = parse(db.prepare(`SELECT feedback_json FROM feedback WHERE student_id = ? AND assignment_id = ?
    ORDER BY updated_at DESC, id DESC LIMIT 1`).get(st.student_id, result.id)?.feedback_json, {});
  return upsertStudentSuggestion(db, {
    assignmentId: result.schoology_assignment_id,
    student: st.student_id,
    rubric_scores: rubric_scores ?? latest.rubric_scores ?? {},
    narrative_feedback: narrative ?? latest.narrative_feedback ?? '',
    reviewer_flags, reviewer_flags_brief,
  });
}

// One student's write. → { student, status, message?, test, result }: `test` and `result` are each
// part's own outcome, or null when the call did not carry that part.
function writeOne(db, data, s) {
  const fail = (message) => ({ student: s.student, status: 'error', message, test: null, result: null });
  const studentId = resolveStudentId(db, s.student);
  if (!studentId) return fail(`Student not found: ${s.student}`);
  const st = data.students.find(x => x.student_id === studentId);
  if (!st) return fail('No attempt on this quiz');
  const impression = String(s.impression ?? '').trim();
  const narrative = s.narrative == null ? null : String(s.narrative).trim();
  const levels = hasLevels(s.rubric_scores) ? s.rubric_scores : null;
  // An empty narrative is sent on purpose: it clears the result task's comment.
  const hasNarrative = narrative != null;
  if (!impression && !levels && !hasNarrative) return fail('Nothing to write: send an impression, rubric_scores or a narrative');
  const notReady = `Not ready: ${st.blocked.join(', ')}`;
  // Reviewer flags go with the test comment when there is one, else with the result task.
  const flags = { reviewer_flags: s.reviewer_flags, reviewer_flags_brief: s.reviewer_flags_brief };

  let test = null;
  if (impression) {
    test = st.ready
      ? storeTest(db, data, st, { ...flags, quiz_overall: { group_id: data.group.id, impression } })
      : { student: s.student, status: 'error', message: notReady };
  }
  let result = null;
  if (levels || hasNarrative) {
    const writeLevels = levels && st.ready;
    if (!data.group.result) result = { student: s.student, status: 'error', message: 'Link this quiz group to its result task first' };
    else if (!writeLevels && !hasNarrative) result = { student: s.student, status: 'error', message: notReady };
    else {
      result = storeResult(db, data, st, {
        rubric_scores: writeLevels ? levels : undefined,
        narrative: hasNarrative ? narrative : undefined,
        ...(impression ? {} : flags),
      });
      if (levels && !writeLevels) result.message = [result.message, `The levels were not written: ${notReady}`].filter(Boolean).join(' ');
    }
  }
  const parts = [test, result].filter(Boolean);
  const written = parts.some(p => p.status === 'written');
  return {
    student: s.student,
    status: written ? 'written' : 'error',
    ...(written ? {} : { message: parts[0].message }),
    test, result,
  };
}

export function writeOverallSuggestions(db, { groupId, students }) {
  const data = loadedResults(db, groupId);
  const results = (students || []).map((s) => writeOne(db, data, s));
  return { written: results.filter(r => r.status === 'written').length, results };
}

// Update numbers: the same test suggestion with the current numbers and template; the result task is not touched.
export function rebuildOverallSuggestion(db, { groupId, studentId }) {
  const data = loadedResults(db, groupId);
  const st = data.students.find(x => x.student_id === Number(studentId));
  if (!st) throw new QuizError('NOT_FOUND', 'No attempt on this quiz for that student');
  if (!st.overall) throw new QuizError('NOT_ELIGIBLE', 'There is no overall suggestion to update');
  if (!st.ready) throw new QuizError('NOT_ELIGIBLE', `Not ready: ${st.blocked.join(', ')}`);
  if (st.overall.edited) throw new QuizError('NOT_ELIGIBLE', 'The comment was edited: write the overall result again to update it');
  const fj = JSON.parse(db.prepare('SELECT feedback_json FROM feedback WHERE id = ?').get(st.overall.feedback_id).feedback_json);
  storeTest(db, data, st, {
    rubric_scores: fj.rubric_scores, reviewer_flags: fj.reviewer_flags, reviewer_flags_brief: fj.reviewer_flags_brief,
    strengths: fj.strengths, suggestions: fj.suggestions, scale_level: fj.scale_level, evidence: fj.evidence,
    quiz_overall: fj.quiz_overall,
  });
  return quizResults(db, { groupId }).students.find(x => x.student_id === st.student_id);
}
