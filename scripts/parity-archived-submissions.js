#!/usr/bin/env node
// Parity (#72 reversed, 19/10/2026): run the one-time archived submissions backfill
// on a DATABASE COPY (DB_PATH) and compare it against what the current-course sync
// stored while those courses were current. Courses synced while current (they have
// submission marks already) must come out the same; the rest are counted as filled.
// Read only on Schoology; writes only to the copy. Counts only, no names.
//   DB_PATH=<copy> PRISM_SESSION_DIR=<session copy> node --env-file=.env scripts/parity-archived-submissions.js
import { getDb } from '../server/db/index.js';
import { backfillArchivedSubmissions } from '../server/services/sync.js';

if (!process.env.DB_PATH || /prism\/data\/students\.db$/.test(process.env.DB_PATH)) {
  console.error('Set DB_PATH to a copy, never the prod database.');
  process.exit(2);
}
const db = getDb();
const FIELDS = ['submission_type', 'late', 'draft', 'lti_submission_state', 'latest_revision_at', 'first_submitted_at'];
const snapshot = () => new Map(db.prepare(`
  SELECT g.student_id || ':' || g.assignment_id AS k, c.id AS course, ${FIELDS.map((f) => `g.${f}`).join(', ')}
  FROM grades g JOIN assignments a ON a.id = g.assignment_id JOIN courses c ON c.id = a.course_id
  WHERE c.archived = 1 AND c.excluded = 0`).all().map((r) => [r.k, r]));
const hadMarks = new Set(db.prepare(`
  SELECT DISTINCT a.course_id AS id FROM grades g JOIN assignments a ON a.id = g.assignment_id
  WHERE g.submission_type IS NOT NULL OR g.lti_submission_state IS NOT NULL`).all().map((r) => r.id));

const before = snapshot();
const t = Date.now();
const read = await backfillArchivedSubmissions(db, new Date().toISOString(), { log: (m) => console.log(m.replace(/"[^"]*"/, '"…"')) });
const after = snapshot();
console.log(`\nbackfill: ${read} courses read in ${Math.round((Date.now() - t) / 1000)} s`);

const diff = { same: 0, changed: {}, onlyAfter: 0 };
const filled = { drop: 0, late: 0, lti: 0, assessment: 0 };
for (const [k, a] of after) {
  const b = before.get(k);
  if (hadMarks.has(a.course)) {
    if (!b) { diff.onlyAfter++; continue; }
    const changed = FIELDS.filter((f) => String(a[f] ?? '') !== String(b[f] ?? ''));
    if (!changed.length) diff.same++;
    for (const f of changed) diff.changed[f] = (diff.changed[f] || 0) + 1;
  } else {
    if (a.submission_type === 'drop') filled.drop++;
    if (a.submission_type === 'assessment') filled.assessment++;
    if (Number(a.late) === 1) filled.late++;
    if (a.lti_submission_state) filled.lti++;
  }
}
console.log(`courses synced while current (${hadMarks.size} with marks): ${diff.same} cells unchanged, changed by field ${JSON.stringify(diff.changed)}, new rows ${diff.onlyAfter}`);
console.log(`courses imported as archived: now ${filled.drop} dropbox uploads, ${filled.late} late, ${filled.lti} OneDrive/LTI states, ${filled.assessment} test takers`);
console.log(`stamped: ${db.prepare('SELECT COUNT(*) n FROM courses WHERE archived = 1 AND submissions_read_at IS NOT NULL').get().n} archived courses`);
