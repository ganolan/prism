// The overall-result read model (spec §13): per student, the MCQ score, percent by tag,
// confirmed FRQ marks, readiness for an overall suggestion, and the state of that suggestion.
// Built only from Prism's stored copy; nothing here reads Schoology.
import { getGroup, attemptUrl } from './quizGroups.js';
import { schoologyMarkOf } from './frqMarks.js';
import { levelsOf } from './frqResponses.js';
import { getAlignedTopics } from './assessmentContext.js';
import { studentFullName } from './studentNames.js';
import { buildComment, frqLevelsText } from '../lib/quizComment.js';

const parse = (t, fallback = null) => (t ? JSON.parse(t) : fallback);
const pct = (n, d) => (d ? Math.round((100 * n) / d) : null);
const byName = (x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0);

// The mark the overall result may use: the teacher's Prism mark, else Schoology's own mark
// when it covers every rubric row. A Prism suggestion the teacher has not acted on blocks.
// A cell whose points match no level of its row (the rubric changed, or Schoology holds odd points)
// is never confirmed, so a comment can never print an empty level.
const onRubric = (rubric, cells) => !rubric || rubric.rows.every(r => r.levels.some(l => l.points === Number(cells[r.id])));

export function confirmedMark(markRow, schoology, rubric) {
  let found;
  if (markRow?.final_cells_json && markRow.state !== 'suggested') found = { source: 'prism', cells: parse(markRow.final_cells_json) };
  else if (markRow?.state === 'suggested') return { reason: 'to review' };
  else {
    const cells = schoology?.cells || {};
    const complete = rubric ? rubric.rows.every(r => cells[r.id] != null) : cells.points != null;
    if (!complete) return { reason: 'not marked' };
    found = { source: 'schoology', cells };
  }
  return onRubric(rubric, found.cells) ? found : { reason: 'not on the rubric' };
}

function overallFor(db, group, studentId, template, values, ready) {
  if (!group.result) return null;
  const fb = db.prepare(`SELECT * FROM feedback WHERE student_id = ? AND assignment_id = ?
    ORDER BY updated_at DESC, id DESC LIMIT 1`).get(studentId, group.result.id);
  const fj = parse(fb?.feedback_json, {});
  if (!fb || fj.quiz_overall?.group_id !== group.id) return null;
  const rebuilt = buildComment(template, { ...values, impression: fj.quiz_overall.impression });
  return {
    feedback_id: fb.id, rubric_scores: fj.rubric_scores || {}, impression: fj.quiz_overall.impression,
    status: fb.status, suggestion_state: fb.suggestion_state ?? null,
    stale: ready && rebuilt !== (fj.narrative_feedback ?? ''),
  };
}

export function quizResults(db, { groupId }) {
  const group = getGroup(db, groupId);
  const questions = db.prepare('SELECT * FROM quiz_questions WHERE group_id = ? ORDER BY position').all(group.id);
  const mcqs = questions.filter(q => q.kind === 'mcq');
  const frqs = questions.filter(q => q.kind === 'frq');
  const template = group.comment_template ?? group.default_comment_template;

  const attempts = db.prepare(`SELECT qa.id, qa.student_id, qa.schoology_attempt_id, qa.completed_at,
      s.schoology_uid, s.first_name, s.last_name, s.preferred_name, s.preferred_name_teacher, a.schoology_assignment_id AS member_sid
    FROM quiz_attempts qa JOIN students s ON s.id = qa.student_id JOIN assignments a ON a.id = qa.assignment_id
    WHERE qa.group_id = ?`).all(group.id);
  const responseQ = db.prepare('SELECT * FROM quiz_responses WHERE attempt_id = ? AND question_id = ?');
  const markQ = db.prepare('SELECT * FROM frq_marks WHERE attempt_id = ? AND question_id = ?');

  const students = attempts.map((a) => {
    const correctOf = (q) => responseQ.get(a.id, q.id)?.is_correct === 1;
    const mcqCorrect = mcqs.filter(correctOf).length;
    const tags = new Map();
    for (const q of mcqs) {
      for (const tag of parse(q.tags_json, [])) {
        const t = tags.get(tag) || { tag, correct: 0, total: 0 };
        t.total += 1;
        if (correctOf(q)) t.correct += 1;
        tags.set(tag, t);
      }
    }
    const frq = frqs.map((q) => {
      const rubric = parse(q.schoology_rubric_json);
      const c = confirmedMark(markQ.get(a.id, q.id), schoologyMarkOf(responseQ.get(a.id, q.id), rubric), rubric);
      const base = { question: q.position, has_rubric: !!rubric, max_points: q.max_points };
      if (!c.cells) return { ...base, confirmed: false, source: null, reason: c.reason, levels: [], points: null };
      const levels = levelsOf(rubric, c.cells);
      return { ...base, confirmed: true, source: c.source, reason: null, levels, points: levels.reduce((n, l) => n + Number(l.points ?? 0), 0) };
    });
    const blocked = frq.filter(f => !f.confirmed).map(f => `Q${f.question} ${f.reason}`);
    const ready = blocked.length === 0;
    const mcq = mcqs.length ? { correct: mcqCorrect, total: mcqs.length, percent: pct(mcqCorrect, mcqs.length) } : null;
    const comment_values = {
      mcq_correct: mcq?.correct ?? null, mcq_total: mcq?.total ?? null, mcq_percent: mcq?.percent ?? null,
      frq_levels: frqs.length && ready ? frqLevelsText(frq) : null,
    };
    return {
      student_id: a.student_id, name: studentFullName(a), schoology_uid: a.schoology_uid, attempt_url: attemptUrl(a),
      mcq, by_tag: [...tags.values()].map(t => ({ ...t, percent: pct(t.correct, t.total) })),
      frq, ready, blocked, comment_values,
      overall: overallFor(db, group, a.student_id, template, comment_values, ready),
    };
  }).sort(byName);

  const taken = new Set(attempts.map(a => a.student_id));
  const not_taken = db.prepare(`SELECT s.id, s.schoology_uid, s.first_name, s.last_name, s.preferred_name, s.preferred_name_teacher
    FROM enrolments e JOIN students s ON s.id = e.student_id WHERE e.course_id = ? AND e.dropped_at IS NULL`).all(group.course_id)
    .filter(s => !taken.has(s.id)).map(s => ({ student_id: s.id, name: studentFullName(s), schoology_uid: s.schoology_uid })).sort(byName);

  const resultRow = group.result
    ? db.prepare('SELECT course_id, schoology_assignment_id FROM assignments WHERE id = ?').get(group.result.id)
    : null;
  return {
    group: {
      id: group.id, title: group.title, loaded_at: group.loaded_at, template, template_is_default: group.comment_template == null,
      result: group.result ? {
        ...group.result,
        topics: getAlignedTopics(db, resultRow.course_id, resultRow.schoology_assignment_id).map(t => ({ external_id: t.external_id, title: t.title })),
      } : null,
    },
    questions: { mcq: mcqs.length, frq: frqs.map(q => ({ position: q.position, has_rubric: !!q.schoology_rubric_json, max_points: q.max_points })) },
    students,
    not_taken,
  };
}
