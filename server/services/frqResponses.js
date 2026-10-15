// The FRQ read model (spec §12): what the Free response tab, the REST route and the MCP tools
// show. Built only from Prism's stored copy; nothing here reads Schoology.
import { QuizError } from './quizError.js';
import { getGroup, attemptUrl } from './quizGroups.js';
import { groupStats } from './quizStats.js';
import { schoologyMarkOf, markView } from './frqMarks.js';
import { levelNameFor } from '../lib/parseQuizRubric.js';
import { studentFullName } from './studentNames.js';

const parse = (t, fallback = null) => (t ? JSON.parse(t) : fallback);

export function levelsOf(rubric, cells) {
  if (!rubric) return [{ row: 'Points', level: null, points: cells?.points ?? null }];
  return rubric.rows.map(r => ({ row: r.title, level: levelNameFor(rubric, r.id, cells?.[r.id]), points: cells?.[r.id] ?? null }));
}

export function frqResponses(db, { groupId, position = null }) {
  const group = getGroup(db, groupId);
  const qs = db.prepare(`SELECT * FROM quiz_questions WHERE group_id = ? AND kind = 'frq' ORDER BY position`).all(group.id)
    .filter(q => position == null || q.position === Number(position));
  if (position != null && !qs.length) throw new QuizError('NOT_FOUND', `Quiz group ${group.id} has no free-response question ${position}`);
  const mcqByStudent = new Map((groupStats(db, { groupId: group.id }).mcq.students || []).map(s => [s.student_id, s]));
  const attempts = db.prepare(`SELECT qa.id, qa.student_id, qa.schoology_attempt_id, qa.completed_at,
      s.schoology_uid, s.first_name, s.last_name, s.preferred_name, s.preferred_name_teacher, a.schoology_assignment_id AS member_sid
    FROM quiz_attempts qa JOIN students s ON s.id = qa.student_id JOIN assignments a ON a.id = qa.assignment_id
    WHERE qa.group_id = ?`).all(group.id);
  const responseQ = db.prepare('SELECT * FROM quiz_responses WHERE attempt_id = ? AND question_id = ?');
  const markQ = db.prepare('SELECT * FROM frq_marks WHERE attempt_id = ? AND question_id = ?');
  const students = attempts.map(a => {
    const responses = {};
    for (const q of qs) {
      const r = responseQ.get(a.id, q.id);
      const schoology = schoologyMarkOf(r, parse(q.schoology_rubric_json));
      responses[q.position] = { answer_html: r?.answer_html ?? null, schoology, mark: markView(markQ.get(a.id, q.id), schoology) };
    }
    const m = mcqByStudent.get(a.student_id);
    return {
      student_id: a.student_id, name: studentFullName(a), schoology_uid: a.schoology_uid,
      attempt_id: a.id, attempt_url: attemptUrl(a), completed_at: a.completed_at,
      mcq: m ? { correct: m.correct, total: m.total, percent: m.percent } : null,
      responses,
    };
  }).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  return {
    group_id: group.id,
    questions: qs.map(q => ({ id: q.id, position: q.position, stem_html: q.stem_html, max_points: q.max_points, rubric: parse(q.schoology_rubric_json) })),
    students,
  };
}

export function listWritebacks(db, { groupId }) {
  const data = frqResponses(db, { groupId });
  const writebacks = [];
  for (const s of data.students) {
    for (const q of data.questions) {
      const m = s.responses[q.position]?.mark;
      if (!m?.final || !['pending', 'failed'].includes(m.writeback.status)) continue;
      writebacks.push({
        student_id: s.student_id, name: s.name, question: q.position, attempt_url: s.attempt_url,
        levels: levelsOf(q.rubric, m.final.cells), comment: m.final.comment, status: m.writeback.status, error: m.writeback.error,
      });
    }
  }
  return { writebacks };
}
