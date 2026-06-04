// Resolve a free-form rubric_scores object to { [topicId]: level }.
// Key match: topic external_id first, then title (both case-insensitive).
// Value must be one of ED/EX/D/EM/IE; unmatched keys / out-of-set values are
// dropped (logged, never blocking) — the overlay is best-effort (spec §5).
const VALID_LEVELS = ['ED', 'EX', 'D', 'EM', 'IE'];

export function resolveRubricScores(rubricScores, topics) {
  const out = {};
  if (!rubricScores || typeof rubricScores !== 'object') return out;
  const byExternal = new Map();
  const byTitle = new Map();
  for (const t of topics) {
    if (t.external_id) byExternal.set(String(t.external_id).toLowerCase(), t.id);
    if (t.title) byTitle.set(String(t.title).toLowerCase(), t.id);
  }
  for (const [key, value] of Object.entries(rubricScores)) {
    const k = String(key).toLowerCase();
    const topicId = byExternal.get(k) ?? byTitle.get(k);
    if (topicId == null) { console.debug('[rubricSuggestions] unresolved key', key); continue; }
    if (!VALID_LEVELS.includes(value)) { console.debug('[rubricSuggestions] out-of-set value', key, value); continue; }
    out[topicId] = value;
  }
  return out;
}

// Aggregate resolved suggestions across feedback rows into per-topic counts.
// rows: array of { feedback_parsed: { rubric_scores } }.
export function distributionByTopic(rows, topics) {
  const dist = {};
  for (const t of topics) dist[t.id] = { ED: 0, EX: 0, D: 0, EM: 0, IE: 0 };
  for (const row of rows || []) {
    const resolved = resolveRubricScores(row?.feedback_parsed?.rubric_scores, topics);
    for (const [topicId, level] of Object.entries(resolved)) {
      if (dist[topicId]) dist[topicId][level] += 1;
    }
  }
  return dist;
}
