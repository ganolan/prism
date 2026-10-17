// Course-wide results for one question tag (#139): every linked quiz group in the course,
// counted over MCQs only, as the Questions tab's tag rollup counts them (quizStats.js).
//
// - Per test (quiz group): correct out of the tagged MCQs' responses, so a test's row matches
//   that group's own "By tag" row. Blanks count as wrong.
// - Per student: correct out of the tagged MCQs in each group they sat, as get_quiz_results
//   counts a student's by_tag (quizResults.js). One counted attempt per student per group.
// - A group is dated by its result task's due date, else its earliest member due date, else its
//   first completed attempt, and listed in date order so one objective reads over time.
import { QuizError } from './quizError.js';
import { studentFullName } from './studentNames.js';

const pct = (correct, total) => (total ? Math.round((100 * correct) / total) : null);
const tagsOf = (q) => (q.tags_json ? JSON.parse(q.tags_json) : []);
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function courseTagResults(db, { courseId, tag }) {
  const wanted = String(tag ?? '').trim();
  if (courseId == null || courseId === '') throw new QuizError('NOT_ELIGIBLE', 'Choose a course');
  if (!wanted) throw new QuizError('NOT_ELIGIBLE', 'Choose a tag');
  const course = db.prepare('SELECT id FROM courses WHERE id = ?').get(Number(courseId));
  if (!course) throw new QuizError('NOT_FOUND', `No course ${courseId}`);

  const groups = db.prepare(`SELECT g.id, g.title,
      COALESCE(ra.due_date,
        (SELECT MIN(a.due_date) FROM quiz_group_members m JOIN assignments a ON a.id = m.assignment_id WHERE m.group_id = g.id),
        (SELECT MIN(qa.completed_at) FROM quiz_attempts qa WHERE qa.group_id = g.id)) AS date
    FROM quiz_groups g LEFT JOIN assignments ra ON ra.id = g.result_assignment_id
    WHERE g.course_id = ?`).all(course.id);
  const mcqs = db.prepare(`SELECT q.id, q.group_id, q.position, q.tags_json FROM quiz_questions q
    JOIN quiz_groups g ON g.id = q.group_id WHERE g.course_id = ? AND q.kind = 'mcq' ORDER BY q.group_id, q.position`).all(course.id)
    .map(q => ({ ...q, tags: tagsOf(q) }));

  // Every MCQ tag in the course, most questions first, so the view can switch tags.
  const tagCounts = new Map();
  for (const q of mcqs) for (const t of q.tags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  const courseTags = [...tagCounts].sort((a, b) => b[1] - a[1] || byText(a[0], b[0])).map(([t]) => t);

  const tagged = mcqs.filter(q => q.tags.includes(wanted));
  const taggedIds = new Set(tagged.map(q => q.id));
  const groupIds = [...new Set(tagged.map(q => q.group_id))];
  const marks = groupIds.length ? `(${groupIds.map(() => '?').join(', ')})` : '(NULL)';
  const attempts = db.prepare(`SELECT qa.id, qa.group_id, qa.student_id, s.first_name, s.last_name, s.preferred_name, s.preferred_name_teacher
    FROM quiz_attempts qa JOIN students s ON s.id = qa.student_id WHERE qa.group_id IN ${marks}`).all(...groupIds);
  const responses = db.prepare(`SELECT r.attempt_id, r.question_id, r.is_correct FROM quiz_responses r
    JOIN quiz_attempts qa ON qa.id = r.attempt_id WHERE qa.group_id IN ${marks}`).all(...groupIds)
    .filter(r => taggedIds.has(r.question_id));

  const byQuestion = new Map(tagged.map(q => [q.id, { correct: 0, total: 0 }]));
  const correctByAttempt = new Map();
  for (const r of responses) {
    const c = byQuestion.get(r.question_id);
    c.total++;
    if (r.is_correct === 1) {
      c.correct++;
      correctByAttempt.set(r.attempt_id, (correctByAttempt.get(r.attempt_id) || 0) + 1);
    }
  }

  const groupById = new Map(groups.map(g => [g.id, g]));
  const tests = groupIds.map((gid) => {
    const g = groupById.get(gid);
    const questions = tagged.filter(q => q.group_id === gid).map((q) => {
      const c = byQuestion.get(q.id);
      return { position: q.position, correct: c.correct, total: c.total, percent: pct(c.correct, c.total) };
    });
    const correct = questions.reduce((n, q) => n + q.correct, 0);
    const total = questions.reduce((n, q) => n + q.total, 0);
    return {
      group_id: gid, title: g.title, date: g.date ?? null,
      takers: attempts.filter(a => a.group_id === gid).length,
      correct, total, percent: pct(correct, total), questions,
    };
  }).sort((a, b) => (a.date == null) - (b.date == null) || byText(a.date ?? '', b.date ?? '') || a.group_id - b.group_id);

  const perGroup = new Map(tests.map(t => [t.group_id, t.questions.length]));
  const studentMap = new Map();
  for (const a of attempts) {
    const s = studentMap.get(a.student_id) || { student_id: a.student_id, name: studentFullName(a), correct: 0, total: 0, tests: {} };
    const correct = correctByAttempt.get(a.id) || 0;
    const total = perGroup.get(a.group_id);
    s.tests[a.group_id] = { correct, total };
    s.correct += correct;
    s.total += total;
    studentMap.set(a.student_id, s);
  }
  const students = [...studentMap.values()]
    .map(({ tests: t, ...s }) => ({ ...s, percent: pct(s.correct, s.total), tests: t }))
    .sort((x, y) => x.percent - y.percent || byText(x.name, y.name));

  const correct = tests.reduce((n, t) => n + t.correct, 0);
  const total = tests.reduce((n, t) => n + t.total, 0);
  const text = db.prepare('SELECT text FROM quiz_tag_texts WHERE course_id = ? AND tag = ?').get(course.id, wanted)?.text ?? null;
  return {
    course_id: course.id, tag: wanted, text,
    overall: { correct, total, percent: pct(correct, total) },
    tests, students, courseTags,
  };
}
