// Shared assessment-context reads. The whole-class rubric view in
// server/routes/mastery.js and the existing-suggestions read in
// server/routes/feedback.js were both inlined; they are extracted here so the
// Express routes and the PrisMCP server compose the same queries (spec §6).
//
// Each helper takes an open better-sqlite3 db. getAssessmentContext composes
// them into the PrisMCP get_assignment_context shape (spec §3.1).

import { resolveAssignmentId } from './idResolvers.js';

// Aligned measurement topics for an assignment (the rubric skeleton), from the
// authoritative mastery_alignments table; falls back to topics that have any
// score for the assignment when alignments haven't synced yet.
export function getAlignedTopics(db, courseId, assignmentSchoologyId) {
  let topics = db.prepare(`
    SELECT DISTINCT mt.*, rc.title AS category_title, rc.external_id AS category_external_id
    FROM measurement_topics mt
    JOIN reporting_categories rc ON rc.id = mt.category_id
    WHERE mt.id IN (
      SELECT ma.topic_id FROM mastery_alignments ma
      WHERE ma.assignment_schoology_id = ? AND ma.course_id = ?
    )
    ORDER BY rc.external_id, mt.external_id
  `).all(assignmentSchoologyId, courseId);

  if (topics.length === 0) {
    topics = db.prepare(`
      SELECT DISTINCT mt.*, rc.title AS category_title, rc.external_id AS category_external_id
      FROM measurement_topics mt
      JOIN reporting_categories rc ON rc.id = mt.category_id
      WHERE mt.id IN (
        SELECT DISTINCT ms.topic_id FROM mastery_scores ms
        WHERE ms.assignment_schoology_id = ?
      )
      ORDER BY rc.external_id, mt.external_id
    `).all(assignmentSchoologyId);
  }
  return topics;
}

// Roster for an assignment, honoring #54 individual targeting: an assignment
// with num_assignees > 0 lists only its assignees, otherwise the whole section.
// assignmentRow may be undefined (unknown assignment) → treated as open-to-all.
export function getRoster(db, courseId, assignmentRow) {
  const targeted = assignmentRow && assignmentRow.num_assignees && assignmentRow.num_assignees > 0;
  return db.prepare(targeted ? `
    SELECT s.id, s.schoology_uid, s.first_name, s.last_name, s.preferred_name, s.preferred_name_teacher,
           s.picture_url, e.schoology_enrolment_id AS enrollment_id
    FROM students s
    JOIN enrolments e ON e.student_id = s.id
    JOIN assignment_assignees aa ON aa.schoology_uid = s.schoology_uid AND aa.assignment_id = ?
    WHERE e.course_id = ?
    ORDER BY s.last_name, s.first_name
  ` : `
    SELECT s.id, s.schoology_uid, s.first_name, s.last_name, s.preferred_name, s.preferred_name_teacher,
           s.picture_url, e.schoology_enrolment_id AS enrollment_id
    FROM students s
    JOIN enrolments e ON e.student_id = s.id
    WHERE e.course_id = ?
    ORDER BY s.last_name, s.first_name
  `).all(...(targeted ? [assignmentRow.id, courseId] : [courseId]));
}

// { schoology_uid: { topic_id: { points, grade } } } for the given topic ids.
export function getScoreMap(db, assignmentSchoologyId, topicIds) {
  const scores = topicIds.length > 0 ? db.prepare(`
    SELECT * FROM mastery_scores WHERE assignment_schoology_id = ?
    AND topic_id IN (${topicIds.map(() => '?').join(',')})
  `).all(assignmentSchoologyId, ...topicIds) : [];
  const scoreMap = {};
  for (const sc of scores) {
    if (!scoreMap[sc.student_uid]) scoreMap[sc.student_uid] = {};
    scoreMap[sc.student_uid][sc.topic_id] = { points: sc.points, grade: sc.grade };
  }
  return scoreMap;
}

// Raw grade-meta rows (comment / exception / comment_status / submission times)
// joined to the schoology_uid, for an assignment. Consumers build their own maps.
export function getGradeMetaRows(db, assignmentSchoologyId) {
  return db.prepare(`
    SELECT s.schoology_uid, g.score, g.submitted_at, g.latest_revision_at,
           g.grade_comment, g.exception, g.comment_status
    FROM grades g
    JOIN students s ON s.id = g.student_id
    JOIN assignments a ON a.id = g.assignment_id
    WHERE a.schoology_assignment_id = ?
  `).all(assignmentSchoologyId);
}

// Existing AI suggestions (draft / teacher_modified) for an assignment (local
// id), keyed by student_id, each with parsed feedback_json. Mirrors the
// feedback for-assignment read; approved rows are excluded so they stop
// re-surfacing as suggestions.
export function getExistingSuggestions(db, assignmentLocalId) {
  const rows = db.prepare(`
    SELECT * FROM feedback
    WHERE assignment_id = ? AND status IN ('draft', 'teacher_modified')
  `).all(assignmentLocalId);
  const byStudent = {};
  for (const row of rows) {
    row.feedback_parsed = JSON.parse(row.feedback_json || '{}');
    byStudent[row.student_id] = row;
  }
  return byStudent;
}

// Compose the PrisMCP get_assignment_context shape (spec §3.1): assignment
// meta + aligned topics + roster with current finals/comments/display-status +
// any existing AI suggestion. assignmentId accepts a Schoology or local id.
// Returns null for an unknown assignment.
export function getAssessmentContext(db, { assignmentId }) {
  const localId = resolveAssignmentId(db, assignmentId);
  const assignmentRow = localId ? db.prepare('SELECT * FROM assignments WHERE id = ?').get(localId) : null;
  if (!assignmentRow) return null;

  const courseId = assignmentRow.course_id;
  const schoolyId = assignmentRow.schoology_assignment_id;

  const topics = getAlignedTopics(db, courseId, schoolyId);
  const roster = getRoster(db, courseId, assignmentRow);
  const scoreMap = getScoreMap(db, schoolyId, topics.map((t) => t.id));
  const suggestions = getExistingSuggestions(db, assignmentRow.id);

  const metaByUid = {};
  for (const g of getGradeMetaRows(db, schoolyId)) metaByUid[g.schoology_uid] = g;

  const students = roster.map((st) => {
    const meta = metaByUid[st.schoology_uid] || {};
    const sug = suggestions[st.id];
    return {
      id: st.id,
      schoology_uid: st.schoology_uid,
      enrollment_id: st.enrollment_id,
      first_name: st.first_name,
      last_name: st.last_name,
      preferred_name: st.preferred_name,
      current_scores: Object.fromEntries(
        Object.entries(scoreMap[st.schoology_uid] || {}).map(([topicId, sc]) => [topicId, { level: sc.grade }])
      ),
      grade_comment: meta.grade_comment || '',
      display_to_student: (meta.comment_status ?? null) === 1,
      exception: meta.exception ?? 0,
      existing_suggestion: sug
        ? {
            status: sug.status,
            narrative_feedback: sug.feedback_parsed.narrative_feedback ?? '',
            rubric_scores: sug.feedback_parsed.rubric_scores ?? {},
            reviewer_flags: sug.feedback_parsed.reviewer_flags ?? null,
          }
        : null,
    };
  });

  return {
    assignment: {
      id: assignmentRow.id,
      schoology_assignment_id: assignmentRow.schoology_assignment_id,
      title: assignmentRow.title,
      max_points: assignmentRow.max_points,
      grading_scale: assignmentRow.grading_scale_id ?? null,
    },
    topics: topics.map((t) => ({
      id: t.id,
      external_id: t.external_id,
      title: t.title,
      category_title: t.category_title,
      category_external_id: t.category_external_id,
    })),
    students,
  };
}
