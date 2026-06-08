export function normalizeTitle(s) {
  return (s || '')
    .toLowerCase()
    .replace(/^\s*anchor standard\s*\d+\s*:\s*/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// criteria: [{ id, standard_title, external_id? }], topics: [{ id, external_id, title }]
// → { mapping: [{criterion_id, topic_id}], unmatched: [criterion_id...] }.
// Each topic is consumed at most once (1:1).
export function autoMatch(criteria, topics) {
  const byExt = new Map();
  const byTitle = new Map();
  for (const t of topics) {
    if (t.external_id) byExt.set(t.external_id.toLowerCase(), t.id);
    byTitle.set(normalizeTitle(t.title), t.id);
  }
  const used = new Set();
  const mapping = [];
  const unmatched = [];
  for (const c of criteria) {
    let topicId = null;
    if (c.external_id && byExt.has(c.external_id.toLowerCase())) {
      topicId = byExt.get(c.external_id.toLowerCase());
    } else {
      topicId = byTitle.get(normalizeTitle(c.standard_title));
    }
    if (topicId && !used.has(topicId)) {
      used.add(topicId);
      mapping.push({ criterion_id: c.id, topic_id: topicId });
    } else {
      unmatched.push(c.id);
    }
  }
  return { mapping, unmatched };
}
