import { feedbackRowTopics, rowTopicMapping } from './feedbackRows.js';

// Rows for RubricDescriptorGrid: one per topic, paired with the attached rubric's
// criterion. Ordered by criterion position; topics with no criterion fall after.
// Shared by the /assessment/ card and the read-only feedback view (#135).
//
// topics: [{ id, title, ... }]; rubric: { criteria: [...], topicByCriterion: [{ criterion_id, topic_id }] }.
export function buildDescriptorRows(topics, rubric) {
  const topicById = Object.fromEntries(topics.map((t) => [t.id, t]));
  const mapping = rubric?.topicByCriterion || [];
  const critByTopic = Object.fromEntries(mapping.map((m) => [m.topic_id, m.criterion_id]));
  const orderedCrit = (rubric?.criteria || []).slice().sort((a, b) => a.position - b.position);
  return [
    ...orderedCrit.map((c) => {
      const tid = mapping.find((x) => x.criterion_id === c.id)?.topic_id;
      return tid && topicById[tid] ? { topic: topicById[tid], criterion: c } : null;
    }).filter(Boolean),
    ...topics.filter((t) => !critByTopic[t.id]).map((t) => ({ topic: t, criterion: null })),
  ];
}

// Feedback rows (spec 2026-10-13): a rubric attached to an unaligned score-scale
// task, every criterion a row. For the read-only view: the rows and the student's
// published level per row (attachment.rowLevels, by criterion name), keyed by the
// row's topic id. null when the attachment is not a feedback-row rubric.
export function feedbackRowView(attachment) {
  if (attachment?.mode !== 'feedback_rows' || !attachment.rubric?.criteria?.length) return null;
  const topics = feedbackRowTopics(attachment.rubric.criteria);
  const rows = buildDescriptorRows(topics, { criteria: attachment.rubric.criteria, topicByCriterion: rowTopicMapping(topics) });
  const levels = attachment.rowLevels || {};
  const gradeByTopic = Object.fromEntries(topics.map((t) => [t.id, levels[t.title] ?? null]));
  return { rows, gradeByTopic };
}

// The read-only view's rows for a student's topics ({ topic_id, title, grade, ... },
// as the gradebook and student page carry them) and an attachment from
// GET /api/rubrics/assignment(s) ({ rubric, topicByCriterion }). null when there is
// nothing to describe: no topics, no attachment, or no topic mapped to a criterion.
export function feedbackDescriptorRows(topics, attachment) {
  if (!topics?.length || !attachment?.rubric) return null;
  const rows = buildDescriptorRows(
    topics.map((t) => ({ ...t, id: t.topic_id })),
    { criteria: attachment.rubric.criteria, topicByCriterion: attachment.topicByCriterion },
  );
  return rows.some((r) => r.criterion) ? rows : null;
}
