// Statistics for the Questions tab (spec §8). Counts, percentages, bands and
// distractor flags only: no discrimination indices or reliability coefficients,
// which a class-sized cohort cannot support. Bands and flags follow csp-tools'
// build_theory_test_review.py.
//
// The loader keeps one counted attempt per student per group (pruneOlderDuplicates),
// so each attempt row here is one student.
import { getGroup } from './quizGroups.js';
import { levelNameFor } from '../lib/parseQuizRubric.js';

const band = (p) => (p == null ? null : p >= 0.9 ? 'Strong' : p >= 0.7 ? 'Mixed' : 'Divided');

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const parseJson = (text, fallback) => (text ? JSON.parse(text) : fallback);

// options: [{ letter, is_key, count }]. Returns flags in the order the Questions tab shows them.
function mcqFlags(options, correct, total, blank) {
  const flags = [];
  const keyCount = options.filter(o => o.is_key).reduce((n, o) => n + o.count, 0);
  const distractors = options.filter(o => !o.is_key);
  const p = total ? correct / total : null;
  for (const o of distractors) {
    if (o.count > keyCount) flags.push({ level: 'critical', text: `Distractor ${o.letter} drew more students than the key.` });
  }
  if (p != null && p < 0.5) flags.push({ level: 'critical', text: 'Fewer than half answered correctly.' });
  if (p === 1) flags.push({ level: 'note', text: 'Nobody missed it.' });
  if (total >= 10) {
    for (const o of distractors) if (o.count === 0) flags.push({ level: 'note', text: `Nobody chose ${o.letter}.` });
  }
  if (distractors.length >= 3 && distractors.every(o => o.count === 1)) {
    flags.push({ level: 'warning', text: 'Every distractor drew exactly one student: a sign of guessing.' });
  }
  if (blank) flags.push({ level: 'warning', text: `${blank} left blank.` });
  return flags;
}

// One FRQ level per answer, from the cell for the rubric's first row. A missing cell,
// null points or no stored rubric is "Not marked". Levels follow the first row's order.
function frqLevels(q, rs) {
  const rubric = parseJson(q.schoology_rubric_json, null);
  const row = rubric?.rows?.[0] ?? null;
  const counts = new Map((row?.levels ?? []).map(l => [l.name, 0]));
  let notMarked = 0;
  for (const r of rs) {
    const cell = row ? parseJson(r.schoology_rubric_cells_json, {})[row.id] : null;
    const name = cell?.points == null ? null : levelNameFor(rubric, row.id, cell.points);
    if (name) counts.set(name, (counts.get(name) || 0) + 1); else notMarked++;
  }
  const levels = [...counts].filter(([, n]) => n > 0).map(([name, count]) => ({ name, count }));
  if (notMarked) levels.push({ name: 'Not marked', count: notMarked });
  return levels;
}

export function groupStats(db, { groupId }) {
  const group = getGroup(db, groupId);
  const attempts = db.prepare('SELECT id, assignment_id, student_id FROM quiz_attempts WHERE group_id = ?').all(group.id);
  const classSize = db.prepare('SELECT COUNT(*) AS n FROM enrolments WHERE course_id = ? AND dropped_at IS NULL').get(group.course_id).n;
  const questions = db.prepare('SELECT * FROM quiz_questions WHERE group_id = ? ORDER BY position').all(group.id);
  const responses = db.prepare(`SELECT r.* FROM quiz_responses r JOIN quiz_attempts qa ON qa.id = r.attempt_id WHERE qa.group_id = ?`).all(group.id);

  const byQuestion = new Map(questions.map(q => [q.id, []]));
  const byAttempt = new Map(attempts.map(a => [a.id, []]));
  for (const r of responses) {
    byQuestion.get(r.question_id)?.push(r);
    byAttempt.get(r.attempt_id)?.push(r);
  }

  const mcqQuestions = questions.filter(q => q.kind === 'mcq');
  const mcqIds = new Set(mcqQuestions.map(q => q.id));

  const outQuestions = questions.map(q => {
    const rs = byQuestion.get(q.id);
    const tags = parseJson(q.tags_json, []);
    if (q.kind !== 'mcq') {
      const out = { position: q.position, kind: q.kind, stem_html: q.stem_html, tags, total: rs.length, correct: null, facility: null, band: null, options: [], blank: 0, flags: [] };
      return q.kind === 'frq' ? { ...out, levels: frqLevels(q, rs) } : out;
    }
    const options = parseJson(q.options_json, []).map(o => ({ ...o, count: rs.filter(r => r.chosen_letter === o.letter).length }));
    const total = rs.length;
    const correct = rs.filter(r => r.is_correct === 1).length;
    const blank = rs.filter(r => !r.chosen_letter).length;
    const facility = total ? correct / total : null;
    return {
      position: q.position, kind: 'mcq', stem_html: q.stem_html, tags, total, correct, facility, band: band(facility),
      options, blank, flags: mcqFlags(options, correct, total, blank),
    };
  });

  // Per-student MCQ percent, then the median across students who sat the group.
  const mcqPercents = attempts.map(a => {
    if (!mcqIds.size) return null;
    const correct = (byAttempt.get(a.id) || []).filter(r => mcqIds.has(r.question_id) && r.is_correct === 1).length;
    return (100 * correct) / mcqIds.size;
  }).filter(x => x != null);
  const medianPercent = median(mcqPercents);

  // The group's FRQ levels: each question's counts summed, in the rubrics' level order, "Not marked" last.
  const frqQuestions = questions.filter(q => q.kind === 'frq');
  const levelCounts = new Map();
  for (const q of frqQuestions) {
    for (const l of parseJson(q.schoology_rubric_json, null)?.rows?.[0]?.levels ?? []) if (!levelCounts.has(l.name)) levelCounts.set(l.name, 0);
  }
  levelCounts.set('Not marked', 0);
  for (const q of outQuestions.filter(x => x.kind === 'frq')) {
    for (const l of q.levels) levelCounts.set(l.name, (levelCounts.get(l.name) || 0) + l.count);
  }
  const notMarked = levelCounts.get('Not marked');
  levelCounts.delete('Not marked');
  const levels = [...levelCounts].filter(([, n]) => n > 0).map(([name, count]) => ({ name, count }));
  if (notMarked) levels.push({ name: 'Not marked', count: notMarked });

  // Tags are aggregated over MCQs only; blanks are in the denominator.
  const tagAgg = new Map();
  for (const q of outQuestions.filter(x => x.kind === 'mcq')) {
    for (const tag of q.tags) {
      const t = tagAgg.get(tag) || { tag, positions: [], correct: 0, total: 0 };
      t.positions.push(q.position);
      t.correct += q.correct;
      t.total += q.total;
      tagAgg.set(tag, t);
    }
  }
  const byTag = [...tagAgg.values()]
    .map(t => ({ ...t, percent: t.total ? Math.round((100 * t.correct) / t.total) : null }))
    .sort((a, b) => (a.percent ?? 101) - (b.percent ?? 101) || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));

  return {
    takers: attempts.length,
    classSize,
    byMember: group.members.map(m => ({
      schoology_assignment_id: m.schoology_assignment_id,
      title: m.title,
      takers: attempts.filter(a => a.assignment_id === m.id).length,
    })),
    mcq: { count: mcqQuestions.length, median_percent: medianPercent == null ? null : Math.round(medianPercent) },
    frq: { count: frqQuestions.length, levels },
    byTag,
    questions: outQuestions,
  };
}
