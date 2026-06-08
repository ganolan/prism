export function normalizeTitle(s) {
  return (s || '')
    // framework code prefix, e.g. "VA:Cr1.1" / "MA:Pr5.1" — an ALL-CAPS subject, a
    // colon, then a token containing a digit. Run before lowercasing so the uppercase
    // prefix is detectable (distinguishes a real code from prose like "Note:2 ...").
    .replace(/^\s*[A-Z]{1,5}:[A-Za-z]*\d[A-Za-z0-9.]*\s*[-–:.)]?\s*/, '')
    .toLowerCase()
    // "Anchor Standard 4:" / "Standard 2:" — the "anchor" word is optional
    .replace(/^\s*(anchor\s+)?standard\s*\d+\s*:\s*/i, '')
    // leading list numbering: "1." / "1)" / "1 -" / "1 –" (ASCII hyphen or en-dash)
    .replace(/^\s*\d+\s*[.)–\-]\s*/, '')
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
