// Quiz groups and links (docs/superpowers/specs/2026-10-12-linked-quiz-results-design.md §3).
// A group is one or more unaligned Schoology tests in one course; it may link to one
// aligned summative in the same course. Nothing here touches Schoology: callers read
// the question lists through quizLoader and pass them in.
import { ALIGNED_SQL } from './triageCommon.js';
import { SCHOOLOGY_BASE } from '../lib/browserSession.js';
import { QuizError } from './quizError.js';
import { compareQuestionLists, matchCopies } from './quizParity.js';
import { normalizeStem } from '../lib/quizText.js';

const ASSIGNMENT_SQL = `SELECT a.id, a.course_id, a.schoology_assignment_id, a.title, a.is_test, ${ALIGNED_SQL} AS aligned
  FROM assignments a`;

export function resolveAssignment(db, ref) {
  return db.prepare(`${ASSIGNMENT_SQL} WHERE a.schoology_assignment_id = ?`).get(String(ref))
    || (/^\d+$/.test(String(ref)) && Number(ref) < 1e9 ? db.prepare(`${ASSIGNMENT_SQL} WHERE a.id = ?`).get(Number(ref)) : null)
    || null;
}

function groupRow(db, groupId) {
  const g = db.prepare('SELECT * FROM quiz_groups WHERE id = ?').get(Number(groupId));
  if (!g) throw new QuizError('NOT_FOUND', `No quiz group ${groupId}`);
  return g;
}

export function getGroup(db, groupId) {
  const g = groupRow(db, groupId);
  const members = db.prepare(`SELECT a.id, a.schoology_assignment_id, a.title FROM quiz_group_members m
    JOIN assignments a ON a.id = m.assignment_id WHERE m.group_id = ? ORDER BY a.id`).all(g.id);
  const result = g.result_assignment_id
    ? db.prepare('SELECT id, schoology_assignment_id, title FROM assignments WHERE id = ?').get(g.result_assignment_id)
    : null;
  return {
    id: g.id, course_id: g.course_id, title: g.title, result, members,
    parity_status: g.parity_status, parity_detail: g.parity_detail_json ? JSON.parse(g.parity_detail_json) : null,
    loaded_at: g.loaded_at, load_summary: g.load_summary_json ? JSON.parse(g.load_summary_json) : null,
    canonical_schoology_id: result ? result.schoology_assignment_id : members[0]?.schoology_assignment_id ?? null,
  };
}

export function listGroups(db, { courseId }) {
  return db.prepare('SELECT id FROM quiz_groups WHERE course_id = ? ORDER BY id').all(Number(courseId)).map(r => getGroup(db, r.id));
}

export function groupForAssignment(db, ref) {
  const a = resolveAssignment(db, ref);
  if (!a) return null;
  const row = db.prepare(`SELECT id FROM quiz_groups WHERE result_assignment_id = ?
    UNION SELECT group_id AS id FROM quiz_group_members WHERE assignment_id = ?`).get(a.id, a.id);
  return row ? getGroup(db, row.id) : null;
}

function assertEligibleTest(db, a, courseId) {
  if (!a) throw new QuizError('NOT_FOUND', 'Unknown assignment');
  if (a.course_id !== Number(courseId)) throw new QuizError('NOT_ELIGIBLE', `"${a.title}" is in another course`);
  if (a.is_test !== 1) throw new QuizError('NOT_ELIGIBLE', `"${a.title}" is not a Schoology test or quiz`);
  if (a.aligned) throw new QuizError('NOT_ELIGIBLE', `"${a.title}" is aligned: only unaligned tests can be combined`);
  if (db.prepare('SELECT 1 FROM quiz_group_members WHERE assignment_id = ?').get(a.id)) {
    throw new QuizError('NOT_ELIGIBLE', `"${a.title}" is already in a quiz group`);
  }
}

export function createGroup(db, { courseId, assignmentRefs, title, questionLists }) {
  if (!assignmentRefs?.length) throw new QuizError('NOT_ELIGIBLE', 'Choose at least one test');
  if (!questionLists || questionLists.length !== assignmentRefs.length) {
    throw new QuizError('NOT_ELIGIBLE', 'Each test needs its question list');
  }
  const tests = assignmentRefs.map(ref => resolveAssignment(db, ref));
  tests.forEach(a => assertEligibleTest(db, a, courseId));
  if (new Set(tests.map(t => t.id)).size !== tests.length) {
    throw new QuizError('NOT_ELIGIBLE', 'The same test is listed twice');
  }
  // questionLists are positional: a list must belong to the test at the same index.
  questionLists.forEach((l, i) => {
    if (l.assignmentId !== undefined && Number(l.assignmentId) !== tests[i].id) {
      throw new QuizError('NOT_ELIGIBLE', `Question list ${i + 1} is not for "${tests[i].title}"`);
    }
  });
  const lists = questionLists.map((l, i) => ({ assignmentId: tests[i].id, title: tests[i].title, questions: l.questions }));
  const parity = compareQuestionLists(lists);
  if (!parity.ok) {
    throw Object.assign(new QuizError('PARITY', 'The tests have different questions'), { differences: parity.differences });
  }
  const tx = db.transaction(() => {
    const groupId = db.prepare('INSERT INTO quiz_groups (course_id, title) VALUES (?, ?)').run(Number(courseId), title || tests[0].title).lastInsertRowid;
    const addMember = db.prepare('INSERT INTO quiz_group_members (group_id, assignment_id) VALUES (?, ?)');
    tests.forEach(a => addMember.run(groupId, a.id));
    const addQ = db.prepare('INSERT INTO quiz_questions (group_id, position, kind, stem_html, max_points) VALUES (?, ?, ?, ?, ?)');
    const addCopy = db.prepare('INSERT INTO quiz_question_copies (question_id, assignment_id, schoology_question_id) VALUES (?, ?, ?)');
    const logicalByQid = new Map();
    lists[0].questions.forEach((q, i) => {
      const id = addQ.run(groupId, i + 1, q.kind, q.stemHtml, q.points).lastInsertRowid;
      logicalByQid.set(q.qid, id);
      addCopy.run(id, lists[0].assignmentId, q.qid);
    });
    for (const l of lists.slice(1)) {
      for (const [otherQid, refQid] of matchCopies(lists[0].questions, l.questions)) {
        addCopy.run(logicalByQid.get(refQid), l.assignmentId, otherQid);
      }
    }
    return groupId;
  });
  return getGroup(db, tx());
}

export function linkResult(db, { groupId, resultRef }) {
  const g = groupRow(db, groupId);
  const a = resolveAssignment(db, resultRef);
  if (!a) throw new QuizError('NOT_FOUND', 'Unknown result task');
  if (a.course_id !== g.course_id) throw new QuizError('NOT_ELIGIBLE', `"${a.title}" is in another course`);
  if (!a.aligned) throw new QuizError('NOT_ELIGIBLE', `"${a.title}" is not aligned to measurement topics`);
  if (a.is_test === 1) throw new QuizError('NOT_ELIGIBLE', `"${a.title}" is a test: link an aligned summative task`);
  const taken = db.prepare('SELECT id FROM quiz_groups WHERE result_assignment_id = ? AND id != ?').get(a.id, g.id);
  if (taken) throw new QuizError('NOT_ELIGIBLE', `"${a.title}" is already linked to another quiz`);
  db.prepare(`UPDATE quiz_groups SET result_assignment_id = ?, updated_at = datetime('now') WHERE id = ?`).run(a.id, g.id);
  return getGroup(db, g.id);
}

export function unlinkResult(db, { groupId }) {
  const g = groupRow(db, groupId);
  db.prepare(`UPDATE quiz_groups SET result_assignment_id = NULL, updated_at = datetime('now') WHERE id = ?`).run(g.id);
  return getGroup(db, g.id);
}

export function deleteGroup(db, { groupId }) {
  const g = groupRow(db, groupId);
  db.transaction(() => {
    const attempts = db.prepare('SELECT id FROM quiz_attempts WHERE group_id = ?').all(g.id).map(r => r.id);
    for (const id of attempts) db.prepare('DELETE FROM quiz_responses WHERE attempt_id = ?').run(id);
    db.prepare('DELETE FROM quiz_attempts WHERE group_id = ?').run(g.id);
    db.prepare('DELETE FROM quiz_question_copies WHERE question_id IN (SELECT id FROM quiz_questions WHERE group_id = ?)').run(g.id);
    db.prepare('DELETE FROM quiz_questions WHERE group_id = ?').run(g.id);
    db.prepare('DELETE FROM quiz_group_members WHERE group_id = ?').run(g.id);
    db.prepare('DELETE FROM quiz_groups WHERE id = ?').run(g.id);
  })();
}

export function setQuestionTags(db, { groupId, tags }) {
  const g = groupRow(db, groupId);
  const update = db.prepare('UPDATE quiz_questions SET tags_json = ? WHERE group_id = ? AND position = ?');
  let updated = 0;
  const unknownPositions = [];
  for (const [pos, list] of Object.entries(tags || {})) {
    const clean = [...new Set((list || []).map(t => String(t).trim()).filter(Boolean))];
    const r = update.run(JSON.stringify(clean), g.id, Number(pos));
    if (r.changes) updated++; else unknownPositions.push(Number(pos));
  }
  return { updated, unknownPositions };
}

// Titles count as similar when one normalized title starts with the other
// (for example "Ep 1 Theory Test" and "Ep 1 Theory Test *"). A suggestion only:
// the teacher confirms every combine.
function similar(a, b) {
  const x = normalizeStem(a), y = normalizeStem(b);
  return x.length > 3 && y.length > 3 && x !== y ? x.startsWith(y) || y.startsWith(x) : x === y;
}

export function listCandidates(db, { courseId }) {
  const rows = db.prepare(`${ASSIGNMENT_SQL} WHERE a.course_id = ? AND a.removed_at IS NULL ORDER BY a.id`).all(Number(courseId));
  const grouped = new Set(db.prepare('SELECT assignment_id FROM quiz_group_members').all().map(r => r.assignment_id));
  const linked = new Set(db.prepare('SELECT result_assignment_id FROM quiz_groups WHERE result_assignment_id IS NOT NULL').all().map(r => r.result_assignment_id));
  const tests = rows.filter(a => a.is_test === 1 && !a.aligned && !grouped.has(a.id));
  return {
    tests: tests.map(t => ({
      id: t.id, schoology_assignment_id: t.schoology_assignment_id, title: t.title,
      suggestedWith: tests.filter(o => o.id !== t.id && similar(o.title, t.title)).map(o => o.schoology_assignment_id),
    })),
    summatives: rows.filter(a => a.aligned && a.is_test !== 1 && !linked.has(a.id))
      .map(a => ({ id: a.id, schoology_assignment_id: a.schoology_assignment_id, title: a.title })),
  };
}

const ATTEMPT_SQL = `SELECT qa.student_id, qa.schoology_attempt_id, qa.completed_at, s.schoology_uid,
    a.schoology_assignment_id AS member_sid, g.result_assignment_id, ra.schoology_assignment_id AS result_sid
  FROM quiz_attempts qa
  JOIN students s ON s.id = qa.student_id
  JOIN assignments a ON a.id = qa.assignment_id
  JOIN quiz_groups g ON g.id = qa.group_id
  LEFT JOIN assignments ra ON ra.id = g.result_assignment_id`;

const linkOf = (r) => ({
  url: `${SCHOOLOGY_BASE}/assignment/${r.member_sid}/assessment_results/student_stats/${r.schoology_uid}/${r.schoology_attempt_id}`,
  completedAt: r.completed_at,
});

// Links for every attempt in the group the ref belongs to (member or result task).
export function attemptLinks(db, { assignmentRef }) {
  const g = groupForAssignment(db, assignmentRef);
  if (!g) return {};
  const rows = db.prepare(`${ATTEMPT_SQL} WHERE qa.group_id = ? ORDER BY qa.completed_at`).all(g.id);
  const out = {};
  for (const r of rows) out[r.student_id] = linkOf(r);
  return out;
}

export function attemptLinksForStudent(db, { studentId }) {
  const out = {};
  for (const r of db.prepare(`${ATTEMPT_SQL} WHERE qa.student_id = ? ORDER BY qa.completed_at`).all(Number(studentId))) {
    out[r.member_sid] = linkOf(r);
    if (r.result_sid) out[r.result_sid] = linkOf(r);
  }
  return out;
}
