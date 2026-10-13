// Feedback rows (spec 2026-10-13): a rubric attached to an unaligned task. The
// card shows each criterion as a pseudo-topic with id 'row:<criterion name>',
// so the grid, drafts, suggestions and class distribution work unchanged. Row
// levels stay in Prism; only the overall scale level is published.
export const ROW_PREFIX = 'row:';
export const rowKey = (name) => `${ROW_PREFIX}${name}`;
export const isRowKey = (key) => String(key).startsWith(ROW_PREFIX);
export const rowName = (key) => String(key).slice(ROW_PREFIX.length);

export function feedbackRowTopics(criteria) {
  return (criteria || []).slice().sort((a, b) => a.position - b.position).map((c) => ({
    id: rowKey(c.criterion_name), external_id: null, title: c.criterion_name,
    category_title: c.reporting_category ?? null, criterion: c,
  }));
}

export function rowScores(rowLevels) {
  return Object.fromEntries(Object.entries(rowLevels || {}).map(([n, level]) => [rowKey(n), { grade: level }]));
}

export function rowTopicMapping(rowTopics) {
  return rowTopics.map((t) => ({ criterion_id: t.criterion.id, topic_id: t.id }));
}
