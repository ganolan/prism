// scripts/parity-bulk-submissions.js
// Live parity check (#55): for a native-dropbox assignment, the bulk
// GET /sections/{sid}/submissions/{aid} grouped by uid must equal the per-student
// GET /sections/{sid}/submissions/{aid}/{uid} on { late, draft, latestRevisionAt }.
// Usage: node scripts/parity-bulk-submissions.js <sectionId> <assignmentId>
import 'dotenv/config';
import { getSectionEnrollments, getSubmissionStatus, getAssignmentSubmissions, apiGet } from '../server/services/schoology.js';
import { groupRevisionsByUid } from '../server/lib/submissionRevisions.js';

const sectionId = process.argv[2];
const assignmentId = process.argv[3];
if (!sectionId || !assignmentId) { console.error('usage: node scripts/parity-bulk-submissions.js <sectionId> <assignmentId>'); process.exit(1); }

const enr = (await getSectionEnrollments(sectionId)).filter(e => e.admin !== '1' && e.admin !== 1);
const raw = await getAssignmentSubmissions(sectionId, assignmentId);
const bulk = groupRevisionsByUid(raw);
// Bulk revisions grouped by uid (raw, not summarized) — for the revision-set check.
const bulkRawByUid = {};
for (const r of raw) (bulkRawByUid[String(r.uid)] ||= []).push(r);

let mismatches = 0;
let setMismatches = 0;
for (const e of enr) {
  const uid = String(e.uid);
  // (1) Summary parity — exactly what the sync consumes (late/draft/timing).
  const single = await getSubmissionStatus(sectionId, assignmentId, uid); // null or summary
  const fromBulk = bulk.get(uid) || null;
  const norm = (s) => s ? { late: s.late ? 1 : 0, draft: s.draft ? 1 : 0, at: s.latestRevisionAt || 0 } : null;
  const a = JSON.stringify(norm(single)), b = JSON.stringify(norm(fromBulk));
  if (a !== b) { mismatches++; console.log(`  SUMMARY MISMATCH uid=${uid}\n    per-student=${a}\n    bulk=       ${b}`); }

  // (2) History note — the bulk endpoint returns only the LATEST revision per
  // student (verified 2026-06-07; the api-ref's "ALL revisions" claim was wrong).
  // That is sync-equivalent: the sync only needs the latest revision's late/draft
  // and the newest NON-draft `created`. A genuine resubmit (newer non-draft) IS
  // the bulk's latest, so latestRevisionAt is correct. The ONLY case bulk could
  // diverge is "latest-by-id is a draft over an earlier non-draft" — and that
  // would change latestRevisionAt, i.e. show up as a SUMMARY mismatch above.
  // So summary parity (gated) is the complete correctness check; this block is
  // informational, surfacing how often bulk truncated multi-revision history.
  const perStudentRaw = (await apiGet(`/sections/${sectionId}/submissions/${assignmentId}/${uid}`))?.revision || [];
  const idsSingle = perStudentRaw.map(r => String(r.revision_id)).sort().join(',');
  const idsBulk = (bulkRawByUid[uid] || []).map(r => String(r.revision_id)).sort().join(',');
  if (idsSingle !== idsBulk) {
    setMismatches++;
    // Risk probe: per-student latest-by-id is a draft AND an earlier non-draft
    // exists → the one scenario where latest-only could be wrong. (Should be
    // caught by the summary check; flag loudly if seen.)
    const latestById = perStudentRaw.reduce((m, r) => (Number(r.revision_id) > Number(m.revision_id) ? r : m), perStudentRaw[0]);
    const hasEarlierNonDraft = perStudentRaw.some(r => Number(r.draft) !== 1 && Number(r.revision_id) < Number(latestById.revision_id));
    const risky = Number(latestById?.draft) === 1 && hasEarlierNonDraft;
    if (risky) console.log(`  ⚠️ RISK uid=${uid}: latest rev ${latestById.revision_id} is a draft over an earlier non-draft — verify summary!`);
  }
}

// Multi-revision coverage: confirm the bulk form returns ALL revisions per student.
const counts = {};
for (const r of raw) counts[r.uid] = (counts[r.uid] || 0) + 1;
const multi = Object.entries(counts).filter(([, n]) => n > 1);

console.log(`\n=== PARITY #55 (section ${sectionId} / assignment ${assignmentId}) ===`);
console.log(`students: ${enr.length} | bulk revisions: ${raw.length} | summary-mismatches: ${mismatches}`);
console.log(`ℹ️ bulk returns latest-only: ${setMismatches} student(s) had older revisions truncated by the bulk endpoint (sync-equivalent as long as summary-mismatches=0).`);
// PASS = summary parity (exactly what the sync consumes). The history-truncation
// note above is informational, not a failure.
const ok = mismatches === 0;
console.log(ok ? '✅ PARITY OK (summary)' : '❌ PARITY FAILED');
process.exit(ok ? 0 : 1);
