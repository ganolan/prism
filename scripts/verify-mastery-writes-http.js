// Live check of the mastery writes over plain HTTP (#141): Prism's own writeMasteryScores
// and writeMasteryOverride (server/services/masterySync.js), no browser.
//
// DEFAULT IS READ-ONLY: prints one student's observation set on one assignment and their
// rollup (with any override) on one objective.
// The WRITES run only with a CONFIRM matching the arguments, after the teacher's
// explicit go-ahead on that target. Each writes back the value already there, so the
// student's data ends where it started:
//   CONFIRM=observations:<assignmentId>:<uid>  posts the same observation set again.
//   CONFIRM=override:<objectiveId>:<uid>       sets the override already there again;
//                                              with no override, sets SET (a grade_scaled
//                                              such as 62.50) and then clears it.
// Each write is read back.
//
// Usage: [PRISM_SESSION_DIR=…] node scripts/verify-mastery-writes-http.js <sectionId> <uid> <assignmentId> <objectiveId>
import 'dotenv/config';

const [sectionId, uid, aid, objectiveId] = process.argv.slice(2);
if (!sectionId || !uid || !aid || !objectiveId) { console.error('usage: <sectionId> <uid> <assignmentId> <objectiveId>'); process.exit(1); }
const confirm = process.env.CONFIRM || '';

const { openMasteryReader, writeMasteryScores, writeMasteryOverride } = await import('../server/services/masterySync.js');
const { getSectionEnrollments } = await import('../server/services/schoology.js');
const { schoologyScaleId } = await import('../server/lib/proficiencyScale.js');

const BASE = 'https://schoology.hkis.edu.hk';
const t0 = Date.now();
const client = await openMasteryReader(sectionId);
console.log(`mastery page over HTTP: ${Date.now() - t0} ms, building ${client.buildingId}`);

// observations/search keys each score by alignment_id, which is NOT the topic UUID the
// write's gradeInfo needs: alignments/search maps it (`id` → `objective.id`). The topics
// are the ones aligned to the assignment (aligned-objectives, then alignments/search).
async function alignmentTopics() {
  const cats = await client.getJson(`${BASE}/course/${sectionId}/district_mastery/api/aligned-objectives?building_id=${client.buildingId}&section_id=${sectionId}`);
  const ids = (cats.data || []).flatMap((c) => [c.id, ...(c.child_objectives || []).map((t) => t.id)]);
  const r = await client.postJson(`${BASE}/course/${sectionId}/district_mastery/api/alignments/search`, {
    building_id: Number(client.buildingId), section_id: Number(sectionId), objective_ids: ids.join(','), include_gradeable_materials_only: true,
  });
  return new Map((r.data || []).filter((a) => String(a.gradeable_material?.material?.id) === String(aid)).map((a) => [a.id, a.objective?.id]));
}
const topicOf = await alignmentTopics();
async function observations() {
  const r = await client.getJson(`${BASE}/course/${sectionId}/district_mastery/api/observations/search?student_uids=${uid}&section_id=${sectionId}&material_type=ASSIGNMENT&material_id=${aid}`);
  const map = {};
  for (const o of r.data || []) {
    const topic = topicOf.get(o.alignment_id);
    if (!topic) throw new Error(`No topic for alignment ${o.alignment_id}: stopping before any write`);
    if (o.points != null) map[topic] = String(Number(o.points));
  }
  return Object.fromEntries(Object.entries(map).sort());
}
async function override() {
  const r = await client.postJson(`${BASE}/course/${sectionId}/district_mastery/api/outcomes/objectives`, {
    building_id: Number(client.buildingId), section_id: Number(sectionId), student_uids: String(uid), ids: objectiveId,
  });
  const so = r.data?.[0]?.student_outcomes?.find((x) => String(x.student_uid) === String(uid));
  return { outcome: so?.outcome?.grade_scaled_rounded ?? null, override: so?.outcome_override?.grade_scaled ?? null };
}

const obsBefore = await observations();
console.log(`observations before: ${JSON.stringify(obsBefore)}`);
const ovBefore = await override();
console.log(`rollup before: ${JSON.stringify(ovBefore)}`);

if (confirm === `observations:${aid}:${uid}`) {
  if (!Object.keys(obsBefore).length) { console.error('No observations to write back. Stopping.'); process.exit(1); }
  const enrollment = (await getSectionEnrollments(sectionId)).find((e) => String(e.uid) === String(uid));
  if (!enrollment) { console.error('No enrollment for that uid. Stopping.'); process.exit(1); }
  const material = await client.getJson(`${BASE}/iapi2/district-mastery/course/${sectionId}/materials?material_id_types[0]=${aid}|ASSIGNMENT`);
  const m = (material.data || []).find((x) => String(x.id) === String(aid));
  if (!m) { console.error('No material record for that assignment. Stopping.'); process.exit(1); }
  const gradeInfo = Object.fromEntries(Object.entries(obsBefore).map(([id, points]) => [id, { grade: points, gradingScaleId: schoologyScaleId() }]));
  const t1 = Date.now();
  await writeMasteryScores({ sectionId, enrollmentId: enrollment.id, assignmentId: aid, gradeInfo, gradingPeriodId: m.grading_period_id, gradingCategoryId: m.grading_category_id });
  console.log(`writeMasteryScores: ${Date.now() - t1} ms`);
  const after = await observations();
  console.log(`observations after: ${JSON.stringify(after)}`);
  console.log(`read-back: ${JSON.stringify(after) === JSON.stringify(obsBefore) ? 'OK, the same set' : 'DIFFERENT'}`);
} else if (confirm === `override:${objectiveId}:${uid}`) {
  const steps = ovBefore.override != null ? [ovBefore.override] : [process.env.SET, null];
  if (steps[0] == null) { console.error('No override there: pass SET=<grade_scaled> to set one and clear it. Stopping.'); process.exit(1); }
  for (const gradeScaled of steps) {
    const t1 = Date.now();
    const r = await writeMasteryOverride({ sectionId, objectiveId, studentUid: uid, gradeScaled });
    console.log(`writeMasteryOverride(${gradeScaled}): ${Date.now() - t1} ms → ${JSON.stringify(r?.data?.outcome_override ?? null)}`);
    console.log(`  rollup now: ${JSON.stringify(await override())}`);
  }
  const after = await override();
  console.log(`read-back: ${after.override === ovBefore.override ? 'OK, the override ends as it started' : 'DIFFERENT'}`);
} else {
  console.log(`read-only. To write: CONFIRM=observations:${aid}:${uid} or CONFIRM=override:${objectiveId}:${uid}`);
}
