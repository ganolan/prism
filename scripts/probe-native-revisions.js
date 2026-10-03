// Probe (#53/#49): full per-student revision history vs REST grade timestamp for
// one native-dropbox assignment. READ-ONLY (public API GETs). Prints uids only.
// Usage: node scripts/probe-native-revisions.js <sectionId> <assignmentId> <uid> [<uid>…]
import 'dotenv/config';
import { apiGet, getSectionGrades, getSectionEnrollments } from '../server/services/schoology.js';

const [sectionId, aid, ...uids] = process.argv.slice(2);
const t = (e) => (e ? new Date(e * 1000).toLocaleString('en-GB', { hour12: false }) : '—');
const enrol = await getSectionEnrollments(sectionId);
const enrolByUid = new Map(enrol.map((e) => [String(e.uid), String(e.id)]));
const grades = (await getSectionGrades(sectionId)).filter((g) => String(g.assignment_id) === aid);
for (const uid of uids) {
  const g = grades.find((x) => String(x.enrollment_id) === enrolByUid.get(uid));
  const data = await apiGet(`/sections/${sectionId}/submissions/${aid}/${uid}`);
  const revs = data?.revision || [];
  console.log(`\nuid=${uid} REST grade=${g?.grade ?? '—'} timestamp=${t(Number(g?.timestamp))} revisions=${revs.length}`);
  for (const r of revs) console.log(`   rev ${r.revision_id} created=${t(Number(r.created))} draft=${r.draft} late=${r.late} items=${r.num_items}`);
}
const bulk = await apiGet(`/sections/${sectionId}/submissions/${aid}?limit=100`);
console.log('\nbulk latest per student:', (bulk?.revision || []).filter((r) => uids.includes(String(r.uid))).map((r) => `${r.uid}:${t(Number(r.created))}`).join('  '));
