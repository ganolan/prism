// PrisMCP write path. Upserts AI grading suggestions into the existing feedback
// table (and, for assessment-wide analysis, assessment_analysis) for teacher
// review on /assessment/:id. Writes ONLY these two tables — never
// mastery_scores, grades, or Schoology — so a re-grade can never clobber a
// grade the teacher entered (spec §5).

import { resolveStudentId, resolveAssignmentId } from './idResolvers.js';
import { getAlignedTopics } from './assessmentContext.js';

// Proficiency vocabulary (spec §4). Accept full names OR codes, case-insensitive;
// normalize to the stored code. Anything else is reported, never written.
const LEVEL_CODES = {
  'exhibiting depth': 'ED', ed: 'ED',
  exhibiting: 'EX', ex: 'EX',
  developing: 'D', d: 'D',
  emerging: 'EM', em: 'EM',
  'insufficient evidence': 'IE', ie: 'IE',
};

export function normalizeLevel(raw) {
  return LEVEL_CODES[String(raw).trim().toLowerCase()] ?? null;
}

// Upsert the single active suggestion for one (student, assignment). Normalizes
// levels, resolves rubric keys against the assignment's aligned topics
// (external_id then title, case-insensitive), and reports — never silently
// drops — unresolved keys and out-of-vocabulary levels. Always writes a fresh
// status='draft' row, pushing any prior feedback_json to revision_history.
export function upsertStudentSuggestion(db, {
  assignmentId, student, narrative_feedback, rubric_scores, reviewer_flags, strengths, suggestions, score,
}) {
  const studentLocalId = resolveStudentId(db, student);
  if (!studentLocalId) return { student, status: 'error', message: `Student not found: ${student}` };
  const assignmentLocalId = resolveAssignmentId(db, assignmentId);
  if (!assignmentLocalId) return { student, status: 'error', message: `Assignment not found: ${assignmentId}` };

  const assignmentRow = db.prepare('SELECT schoology_assignment_id, course_id FROM assignments WHERE id = ?').get(assignmentLocalId);
  const topics = getAlignedTopics(db, assignmentRow.course_id, assignmentRow.schoology_assignment_id);
  const byKey = new Map();
  for (const t of topics) {
    if (t.external_id) byKey.set(String(t.external_id).toLowerCase(), t);
    if (t.title) byKey.set(String(t.title).toLowerCase(), t);
  }

  const storedScores = {};
  const unresolvedTopics = [];
  const invalidLevels = {};
  for (const [key, rawLevel] of Object.entries(rubric_scores || {})) {
    if (!byKey.has(String(key).toLowerCase())) { unresolvedTopics.push(key); continue; }
    const code = normalizeLevel(rawLevel);
    if (!code) { invalidLevels[key] = rawLevel; continue; }
    storedScores[key] = code;
  }

  const feedbackJson = JSON.stringify({
    narrative_feedback: narrative_feedback ?? '',
    rubric_scores: storedScores,
    reviewer_flags: reviewer_flags ?? null,
    strengths: strengths ?? [],
    suggestions: suggestions ?? [],
  });

  const write = db.transaction(() => {
    // The single active suggestion = the most recent feedback row for this
    // (student, assignment), regardless of status — a re-grade does not skip
    // teacher_modified/approved rows (spec §5), it supersedes them as a fresh
    // draft with the prior content preserved in revision_history.
    const existing = db.prepare(
      `SELECT * FROM feedback WHERE student_id = ? AND assignment_id = ?
       ORDER BY updated_at DESC, id DESC LIMIT 1`
    ).get(studentLocalId, assignmentLocalId);

    if (existing) {
      const history = JSON.parse(existing.revision_history || '[]');
      history.push({
        feedback_json: existing.feedback_json,
        score: existing.score,
        status: existing.status,
        changed_at: new Date().toISOString(),
      });
      db.prepare(
        `UPDATE feedback SET status = 'draft', score = ?, feedback_json = ?,
           revision_history = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(score ?? null, feedbackJson, JSON.stringify(history), existing.id);
      return existing.id;
    }
    return db.prepare(
      `INSERT INTO feedback (student_id, assignment_id, status, score, feedback_json)
       VALUES (?, ?, 'draft', ?, ?)`
    ).run(studentLocalId, assignmentLocalId, score ?? null, feedbackJson).lastInsertRowid;
  });

  const feedbackId = write();
  const result = { student, status: 'written', feedback_id: feedbackId };
  if (unresolvedTopics.length) result.unresolved_topics = unresolvedTopics;
  if (Object.keys(invalidLevels).length) {
    result.message = `Ignored out-of-vocabulary levels: ${JSON.stringify(invalidLevels)}`;
  }
  return result;
}

// Batched whole-class write. Returns a per-student written/error summary.
export function writeStudentSuggestions(db, { assignmentId, students }) {
  const results = (students || []).map((s) => upsertStudentSuggestion(db, { assignmentId, ...s }));
  return { results };
}
