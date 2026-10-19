#!/usr/bin/env node
// Parity (#108): the on-demand read (refreshTasks) against the full sync's read
// (syncSectionData), on two DATABASE COPIES made at the same moment. Copy A (DB_PATH)
// gets refreshTasks for every task the dashboard and the course pages would read; copy
// B gets a full read of the same courses' sections. The grades rows of those tasks must
// come out the same. Read only on Schoology; writes only to the copies. Prints ids and
// column names only, no student data.
//   DB_PATH=<copy A> PRISM_SESSION_DIR=<session copy> node --env-file=.env scripts/parity-task-refresh.js <copy B>
import Database from 'better-sqlite3';
import { getDb, migrate } from '../server/db/index.js';
import { refreshTasks } from '../server/services/taskRefresh.js';
import { triageRefreshTargets, courseRefreshTargets } from '../server/services/triage.js';
import { syncSectionData } from '../server/services/sync.js';
import { createSubmissionFetcher } from '../server/services/graderSubmissions.js';

const pathB = process.argv[2];
const isProd = (p) => !p || /prism\/data\/students\.db$/.test(p);
if (isProd(process.env.DB_PATH) || isProd(pathB) || pathB === process.env.DB_PATH) {
  console.error('Set DB_PATH to copy A and pass copy B: two copies, never the prod database.');
  process.exit(2);
}
const dbA = getDb();
const dbB = new Database(pathB);
dbB.pragma('foreign_keys = ON');
migrate(dbB);

const courses = dbA.prepare(`SELECT id, schoology_section_id AS section FROM courses
  WHERE COALESCE(archived, 0) = 0 AND COALESCE(excluded, 0) = 0`).all();
const ids = new Set(triageRefreshTargets(dbA, { includeFormative: true }));
for (const c of courses) for (const id of courseRefreshTargets(dbA, c.id)) ids.add(id);
const targets = [...ids];
const touched = new Set(dbA.prepare(`SELECT DISTINCT course_id AS id FROM assignments WHERE id IN (SELECT value FROM json_each(?))`)
  .all(JSON.stringify(targets)).map((r) => r.id));
console.log(`${targets.length} tasks in ${touched.size} courses`);

let t = Date.now();
const a = await refreshTasks(targets, { db: dbA, force: true });
console.log(`A (refreshTasks): ${a.refreshed} read, ${a.failed.length} failed${a.error ? ` (${a.error.replace(/"[^"]*"/g, '"…"')})` : ''}, ${Date.now() - t} ms`);

t = Date.now();
const reader = await createSubmissionFetcher();
try {
  for (const c of courses.filter((x) => touched.has(x.id))) {
    await syncSectionData(dbB, String(c.section), c.id, new Date().toISOString(), {
      fetchDocuments: reader ? (aid) => reader.fetchDocuments(aid) : undefined,
      fetchTestAttempts: reader ? (sid, uids, items) => reader.fetchTestAttempts(sid, uids, items) : undefined,
    });
  }
} finally {
  await reader?.close();
}
console.log(`B (syncSectionData): ${touched.size} sections, ${Date.now() - t} ms${reader ? '' : ' (no session: native only)'}`);

const FIELDS = ['score', 'max_score', 'grade_comment', 'comment_status', 'exception', 'submitted_at', 'late', 'draft',
  'latest_revision_at', 'first_submitted_at', 'submission_type', 'lti_submission_state', 'test_attempt'];
const rows = (db) => new Map(db.prepare(`
  SELECT student_id || ':' || assignment_id AS k, ${FIELDS.join(', ')} FROM grades
  WHERE assignment_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(targets)).map((r) => [r.k, r]));
const rA = rows(dbA);
const rB = rows(dbB);
let same = 0;
const diffs = [];
for (const k of new Set([...rA.keys(), ...rB.keys()])) {
  const x = rA.get(k);
  const y = rB.get(k);
  if (!x || !y) { diffs.push(`${k}: only in ${x ? 'A' : 'B'}`); continue; }
  const cols = FIELDS.filter((f) => String(x[f] ?? '') !== String(y[f] ?? ''));
  if (cols.length) diffs.push(`${k}: ${cols.join(', ')}`); else same++;
}
const status = (db) => db.prepare(`SELECT id, lti_fetch_status AS l, test_fetch_status AS t FROM assignments
  WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`).all(JSON.stringify(targets));
const sA = status(dbA);
const sB = status(dbB);
const statusDiffs = sA.filter((r, i) => r.l !== sB[i].l || r.t !== sB[i].t).map((r) => r.id);
console.log(`grades rows: ${same} identical, ${diffs.length} different`);
for (const d of diffs) console.log(`  ${d}`);
console.log(`fetch statuses: ${statusDiffs.length ? `differ for tasks ${statusDiffs.join(', ')}` : 'identical'}`);
