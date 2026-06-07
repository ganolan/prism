// Pure: regroup the batched material-observations/search POST response
// (#104) back into the per-topic shape the mastery persist step expects.
// The batched POST returns every topic's observations in one array, each row
// tagged with its objective id. Mirrors the field-name fallbacks the spike
// probe used (probe-mastery-batch.js).

const objectiveOf = (o) =>
  o?.objective_id ?? o?.objective?.id ?? o?.measurement_topic_id ?? o?.objectiveId ?? null;

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
