// Stores what a load read (spec §5). One counted attempt per student per member
// test; responses keyed by logical question. Never touches anything a teacher
// writes in Prism (FRQ marks arrive in phase 2 in their own table).
import { compareLoadedQuestion, storedLetterFor } from './quizParity.js';
import { QuizError } from './quizError.js';

const json = (v) => (v == null ? null : JSON.stringify(v));

export function storeAttempt(db, { groupId, assignmentId, studentId, attempt, attemptCount, parsed, rubrics = {}, gradeInfo = {} }) {
  if (!db.prepare('SELECT 1 FROM quiz_group_members WHERE group_id = ? AND assignment_id = ?').get(groupId, assignmentId)) {
    throw new QuizError('NOT_FOUND', `Test ${assignmentId} is not a member of quiz group ${groupId}`);
  }
  const logical = db.prepare(`SELECT qq.id, qq.position, qq.options_json, qq.schoology_rubric_json, c.schoology_question_id AS qid
    FROM quiz_question_copies c JOIN quiz_questions qq ON qq.id = c.question_id
    WHERE qq.group_id = ? AND c.assignment_id = ?`).all(groupId, assignmentId);
  const byQid = new Map(logical.map(l => [l.qid, l]));
  const mismatches = [];

  db.transaction(() => {
    // A retake of the same test keeps the row but is a new answer: the old attempt's FRQ marks
    // must never follow it (a mark accepted for the old answer would be posted onto the new one).
    const previous = db.prepare('SELECT id, schoology_attempt_id FROM quiz_attempts WHERE assignment_id = ? AND student_id = ?').get(assignmentId, studentId);
    if (previous && previous.schoology_attempt_id !== String(attempt.attemptId)) {
      db.prepare('DELETE FROM frq_marks WHERE attempt_id = ?').run(previous.id);
    }
    // Upsert so the attempt keeps its id across loads (frq_marks hang off it).
    db.prepare(`INSERT INTO quiz_attempts
      (group_id, assignment_id, student_id, schoology_attempt_id, started_at, completed_at, score, max_score, attempt_count, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(assignment_id, student_id) DO UPDATE SET
        group_id = excluded.group_id, schoology_attempt_id = excluded.schoology_attempt_id,
        started_at = excluded.started_at, completed_at = excluded.completed_at,
        score = excluded.score, max_score = excluded.max_score,
        attempt_count = excluded.attempt_count, fetched_at = excluded.fetched_at`).run(
      groupId, assignmentId, studentId, String(attempt.attemptId), attempt.startedAt ?? null, attempt.completedAt ?? null,
      attempt.score ?? null, attempt.maxScore ?? null, attemptCount ?? 1,
    );
    const attemptRowId = db.prepare('SELECT id FROM quiz_attempts WHERE assignment_id = ? AND student_id = ?').get(assignmentId, studentId).id;
    db.prepare('DELETE FROM quiz_responses WHERE attempt_id = ?').run(attemptRowId);

    const addResponse = db.prepare(`INSERT INTO quiz_responses
      (attempt_id, question_id, chosen_letter, is_correct, points, max_points, answer_html, schoology_rubric_cells_json, schoology_comment)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const q of parsed.questions) {
      const l = byQid.get(q.qid);
      if (!l) {
        mismatches.push(`Schoology question ${q.qid}: not in this quiz`);
        continue;
      }
      const options = q.options ? q.options.map(o => ({ letter: o.letter, html: o.html, is_key: o.isKey })) : null;
      const rubric = q.rubric ? rubrics[q.rubric.rubricId] ?? null : null;
      if (l.options_json || l.schoology_rubric_json) {
        const stored = {
          options: l.options_json ? JSON.parse(l.options_json).map(o => ({ ...o, isKey: o.is_key })) : null,
          rubricId: l.schoology_rubric_json ? JSON.parse(l.schoology_rubric_json).id : null,
        };
        const reason = compareLoadedQuestion(stored, { options: q.options, rubricId: rubric?.id ?? null });
        if (reason) mismatches.push(`Question ${l.position}: ${reason}`);
      }
      if (!l.options_json && options) db.prepare('UPDATE quiz_questions SET options_json = ? WHERE id = ?').run(json(options), l.id);
      if (!l.schoology_rubric_json && rubric) db.prepare('UPDATE quiz_questions SET schoology_rubric_json = ? WHERE id = ?').run(json(rubric), l.id);
      // A shuffled attempt shows the options in another order: store the choice under the stored
      // letter with the same text (isCorrect comes from the attempt's own key, so it holds).
      const storedOptions = l.options_json ? JSON.parse(l.options_json) : null;
      const chosenLetter = storedOptions && q.options
        ? storedLetterFor(storedOptions, q.options, q.chosenLetter) ?? q.chosenLetter
        : q.chosenLetter;
      addResponse.run(
        attemptRowId, l.id, chosenLetter, q.isCorrect == null ? null : (q.isCorrect ? 1 : 0),
        q.points, q.maxPoints, q.answerHtml, json(gradeInfo[q.qid] ?? null), q.comment || null,
      );
    }
  })();
  return { stored: true, mismatches };
}

// Deletes the stored attempts (and responses) of these students on one member test.
// Returns how many attempts went.
export function removeAttempts(db, { assignmentId, studentIds }) {
  let removed = 0;
  db.transaction(() => {
    for (const studentId of studentIds) {
      const row = db.prepare('SELECT id FROM quiz_attempts WHERE assignment_id = ? AND student_id = ?').get(assignmentId, studentId);
      if (!row) continue;
      db.prepare('DELETE FROM quiz_responses WHERE attempt_id = ?').run(row.id);
      db.prepare('DELETE FROM quiz_attempts WHERE id = ?').run(row.id);
      removed++;
    }
  })();
  return removed;
}

export function pruneOlderDuplicates(db, { groupId }) {
  const rows = db.prepare(`SELECT id, student_id FROM quiz_attempts WHERE group_id = ?
    ORDER BY student_id, COALESCE(completed_at, '') DESC, COALESCE(started_at, '') DESC, CAST(schoology_attempt_id AS INTEGER) DESC`).all(groupId);
  const keep = new Set();
  const drop = [];
  for (const r of rows) {
    if (keep.has(r.student_id)) drop.push(r.id); else keep.add(r.student_id);
  }
  db.transaction(() => {
    for (const id of drop) {
      db.prepare('DELETE FROM quiz_responses WHERE attempt_id = ?').run(id);
      db.prepare('DELETE FROM quiz_attempts WHERE id = ?').run(id);
    }
  })();
  return drop.length;
}

export function finishLoad(db, { groupId, summary, mismatches }) {
  db.prepare(`UPDATE quiz_groups SET loaded_at = datetime('now'), load_summary_json = ?,
    parity_status = ?, parity_detail_json = ?, updated_at = datetime('now') WHERE id = ?`).run(
    json(summary), mismatches.length ? 'mismatch' : 'ok', mismatches.length ? json([...new Set(mismatches)]) : null, groupId,
  );
}
