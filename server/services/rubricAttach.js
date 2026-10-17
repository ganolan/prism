import { getDb } from '../db/index.js';
import { getAlignedTopics, scoreScaleFor } from './assessmentContext.js';
import { getRubric } from './rubricStore.js';
import { autoMatch } from './rubricMatch.js';
import { hiddenRowLevelCount } from './feedbackRows.js';

// Attach rubric to an assignment (replacing any existing attachment). On an
// aligned task, auto-match its criteria to the aligned topics and persist the
// mapping. On an UNALIGNED score-scale task, every criterion is a feedback row
// (spec 2026-10-13): no topic mapping, and stored row finals are kept.
export function attachRubric(db = getDb(), { rubricId, courseId, assignmentId }) {
  const rubric = getRubric(db, rubricId);
  if (!rubric) throw new Error(`rubric ${rubricId} not found`);
  const topics = getAlignedTopics(db, courseId, assignmentId);
  const assignmentRow = db.prepare('SELECT grading_scale_id FROM assignments WHERE schoology_assignment_id = ?')
    .get(String(assignmentId));
  const scale = scoreScaleFor(assignmentRow, topics.length);
  const { mapping, unmatched } = scale ? { mapping: [], unmatched: [] } : autoMatch(rubric.criteria, topics);
  const now = new Date().toISOString();
  const txn = db.transaction(() => {
    db.prepare(`DELETE FROM rubric_attachments WHERE assignment_schoology_id = ?`).run(assignmentId);
    const attachmentId = db.prepare(
      `INSERT INTO rubric_attachments (rubric_id, assignment_schoology_id, course_id, created_at)
       VALUES (?, ?, ?, ?)`
    ).run(rubricId, assignmentId, courseId, now).lastInsertRowid;
    const insM = db.prepare(
      `INSERT INTO rubric_attachment_topics (attachment_id, criterion_id, topic_id) VALUES (?, ?, ?)`
    );
    for (const m of mapping) insM.run(attachmentId, m.criterion_id, m.topic_id);
    return attachmentId;
  });
  const attachmentId = txn();
  if (!scale) return { attachmentId, unmatched, mode: 'topics' };
  const rows = rubric.criteria.map((c) => c.criterion_name);
  return { attachmentId, unmatched: [], mode: 'feedback_rows', rows, hiddenRowLevels: hiddenRowLevelCount(db, assignmentId, rows), scaleName: scale.name };
}

export function detachAttachment(db = getDb(), attachmentId) {
  db.prepare(`DELETE FROM rubric_attachments WHERE id = ?`).run(attachmentId);
}

export function getAttachmentForAssignment(db = getDb(), assignmentId) {
  const att = db.prepare(
    `SELECT * FROM rubric_attachments WHERE assignment_schoology_id = ?`
  ).get(assignmentId);
  if (!att) return null;
  return attachmentPayload(db, att);
}

// Every attached rubric for a list of assignments at once (the student page shows
// many assignments; one request instead of one per assignment, #135).
// → { [assignment_schoology_id]: { ...attachment, mode } }, assignments without one
// left out. mode is 'feedback_rows' on an unaligned score-scale task (spec
// 2026-10-13), else 'topics'. With studentUid, a feedback-row task also carries
// that one student's published row levels (`rowLevels`, by criterion name, only
// rows of the attached rubric).
export function getAttachmentsForAssignments(db = getDb(), assignmentIds = [], { studentUid = null } = {}) {
  const ids = [...new Set(assignmentIds.map(String).filter(Boolean))];
  if (ids.length === 0) return {};
  const rows = db.prepare(
    `SELECT * FROM rubric_attachments WHERE assignment_schoology_id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids);
  const out = {};
  for (const att of rows) {
    const aid = String(att.assignment_schoology_id);
    const payload = attachmentPayload(db, att);
    const assignment = db.prepare('SELECT * FROM assignments WHERE schoology_assignment_id = ?').get(aid);
    const scale = assignment
      ? scoreScaleFor(assignment, getAlignedTopics(db, assignment.course_id, aid).length)
      : null;
    payload.mode = scale ? 'feedback_rows' : 'topics';
    if (scale && studentUid != null) {
      const names = new Set(payload.rubric.criteria.map((c) => c.criterion_name));
      const levels = db.prepare(
        'SELECT criterion_name, level FROM rubric_row_levels WHERE assignment_schoology_id = ? AND student_uid = ?'
      ).all(aid, String(studentUid));
      payload.rowLevels = Object.fromEntries(levels.filter((l) => names.has(l.criterion_name)).map((l) => [l.criterion_name, l.level]));
    }
    out[aid] = payload;
  }
  return out;
}

function attachmentPayload(db, att) {
  const rubric = getRubric(db, att.rubric_id);
  const maps = db.prepare(
    `SELECT criterion_id, topic_id FROM rubric_attachment_topics WHERE attachment_id = ?`
  ).all(att.id);
  const nameById = Object.fromEntries(rubric.criteria.map(c => [c.id, c.criterion_name]));
  return {
    id: att.id,
    rubric,
    topicByCriterion: maps.map(m => ({ ...m, criterion_name: nameById[m.criterion_id] })),
  };
}

export function setMapping(db = getDb(), attachmentId, criterionId, topicId) {
  // Unmap: a null/empty topic removes this criterion's binding (`== null` catches null & undefined).
  if (topicId == null || topicId === '') {
    db.prepare(`DELETE FROM rubric_attachment_topics WHERE attachment_id = ? AND criterion_id = ?`)
      .run(attachmentId, criterionId);
    return;
  }
  // 1:1 move-semantics: free this topic from any OTHER criterion first, then bind it here.
  const txn = db.transaction(() => {
    db.prepare(
      `DELETE FROM rubric_attachment_topics WHERE attachment_id = ? AND topic_id = ? AND criterion_id != ?`
    ).run(attachmentId, topicId, criterionId);
    db.prepare(
      `INSERT INTO rubric_attachment_topics (attachment_id, criterion_id, topic_id)
       VALUES (?, ?, ?)
       ON CONFLICT(attachment_id, criterion_id) DO UPDATE SET topic_id = excluded.topic_id`
    ).run(attachmentId, criterionId, topicId);
  });
  txn();
}

export function reorderCriteria(db = getDb(), rubricId, orderedCriterionIds) {
  const upd = db.prepare(`UPDATE rubric_criteria SET position = ? WHERE id = ? AND rubric_id = ?`);
  const txn = db.transaction(() => {
    orderedCriterionIds.forEach((id, i) => upd.run(i + 1, id, rubricId));
  });
  txn();
}
