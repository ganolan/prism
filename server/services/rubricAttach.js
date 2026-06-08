import { getDb } from '../db/index.js';
import { getAlignedTopics } from './assessmentContext.js';
import { getRubric } from './rubricStore.js';
import { autoMatch } from './rubricMatch.js';

// Attach rubric to an assignment (replacing any existing attachment), auto-match
// its criteria to the assignment's aligned topics, persist the mapping.
export function attachRubric(db = getDb(), { rubricId, courseId, assignmentId }) {
  const rubric = getRubric(db, rubricId);
  if (!rubric) throw new Error(`rubric ${rubricId} not found`);
  const topics = getAlignedTopics(db, courseId, assignmentId);
  const { mapping, unmatched } = autoMatch(rubric.criteria, topics);
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
  return { attachmentId: txn(), unmatched };
}

export function detachAttachment(db = getDb(), attachmentId) {
  db.prepare(`DELETE FROM rubric_attachments WHERE id = ?`).run(attachmentId);
}

export function getAttachmentForAssignment(db = getDb(), assignmentId) {
  const att = db.prepare(
    `SELECT * FROM rubric_attachments WHERE assignment_schoology_id = ?`
  ).get(assignmentId);
  if (!att) return null;
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
  db.prepare(
    `INSERT INTO rubric_attachment_topics (attachment_id, criterion_id, topic_id)
     VALUES (?, ?, ?)
     ON CONFLICT(attachment_id, criterion_id) DO UPDATE SET topic_id = excluded.topic_id`
  ).run(attachmentId, criterionId, topicId);
}

export function reorderCriteria(db = getDb(), rubricId, orderedCriterionIds) {
  const upd = db.prepare(`UPDATE rubric_criteria SET position = ? WHERE id = ? AND rubric_id = ?`);
  const txn = db.transaction(() => {
    orderedCriterionIds.forEach((id, i) => upd.run(i + 1, id, rubricId));
  });
  txn();
}
