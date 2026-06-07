// Pure: regroup the batched material-observations/search POST response
// (#104) back into the per-topic shape the mastery persist step expects.
// The batched POST returns every topic's observations in one array, each row
// tagged with its objective id. Mirrors the field-name fallbacks the spike
// probe used (probe-mastery-batch.js).

const objectiveOf = (o) =>
  o?.objective_id ?? o?.objective?.id ?? o?.measurement_topic_id ?? o?.objectiveId ?? null;

// The batched POST and the per-topic GET return material-observations rows in
// DIFFERENT shapes (verified 2026-06-07):
//   GET : gradeable_material:{ material_id: 123, material_type }   points: 100   (number)
//   POST: gradeable_material:{ material:{ id: 123, type }, … }     points: "100" (string)
// Normalize a row to the GET shape — guaranteed numeric `gradeable_material.material_id`
// and numeric `points` — so the downstream persist (which reads exactly those two
// fields) behaves identically regardless of source.
export function normalizeObservation(obs) {
  const gm = obs?.gradeable_material || {};
  const materialId = gm.material_id ?? gm.material?.id ?? null;
  return {
    ...obs,
    points: obs?.points == null ? null : Number(obs.points),
    gradeable_material: { ...gm, material_id: materialId },
  };
}

// @param observations flat array from the batched POST `.data`
// @param topicIds     the topic UUIDs we asked for (seeds empty buckets)
// @returns { [topicId]: observation[] }  — every requested topic present
export function groupObservationsByTopic(observations, topicIds) {
  const byTopic = {};
  for (const id of (topicIds || [])) byTopic[String(id)] = [];
  for (const obs of (observations || [])) {
    const oid = objectiveOf(obs);
    if (oid == null) continue;
    const key = String(oid);
    if (!byTopic[key]) byTopic[key] = [];
    byTopic[key].push(obs);
  }
  return byTopic;
}
