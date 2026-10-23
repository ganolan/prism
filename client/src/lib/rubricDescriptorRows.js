// Rows for RubricDescriptorGrid: one per topic, paired with the attached rubric's
// criterion. Ordered by criterion position; topics with no criterion fall after.
// Used by the grade card's descriptor grid in both modes (#176) and the gradebook pop-up's width.
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
