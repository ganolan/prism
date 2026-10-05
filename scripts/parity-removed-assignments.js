// Removed-assignment parity: which local assignment rows are no longer in
// Schoology's /sections/{id}/assignments list, and does a direct GET confirm
// each one is really gone (404)? Read-only: the DB is opened readonly and only
// GETs are sent. Lists exactly the rows sync would mark removed_at.
//
// Run from the REPO ROOT:
//   DB_PATH=~/prism/data/students.db node --env-file=.env scripts/parity-removed-assignments.js
import Database from 'better-sqlite3';
import { apiGet, getSectionAssignments } from '../server/services/schoology.js';

const dbPath = process.env.DB_PATH || 'server/db/students.db';
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const courses = db.prepare(`
  SELECT id, schoology_section_id, course_name FROM courses
  WHERE COALESCE(archived, 0) = 0 AND COALESCE(excluded, 0) = 0
`).all();
const hasRemovedAt = db.prepare(`SELECT 1 FROM pragma_table_info('assignments') WHERE name = 'removed_at'`).get();
const localRows = db.prepare(`
  SELECT a.id, a.schoology_assignment_id AS sid, a.title, substr(a.synced_at, 1, 10) AS synced,
    (SELECT COUNT(*) FROM grades g WHERE g.assignment_id = a.id) AS grades,
    (SELECT COUNT(*) FROM mastery_scores m WHERE m.assignment_schoology_id = a.schoology_assignment_id) AS mastery
  FROM assignments a WHERE a.course_id = ? ${hasRemovedAt ? 'AND a.removed_at IS NULL' : ''}
`);

let missing = 0;
let stillLive = 0;
for (const c of courses) {
  const live = new Set((await getSectionAssignments(c.schoology_section_id)).map(a => String(a.id)));
  const rows = localRows.all(c.id).filter(r => !live.has(r.sid));
  if (!rows.length) continue;
  console.log(`\n${c.course_name} (section ${c.schoology_section_id}): ${rows.length} not in the REST list (REST has ${live.size})`);
  for (const r of rows) {
    missing++;
    let direct;
    try {
      await apiGet(`/sections/${c.schoology_section_id}/assignments/${r.sid}`);
      direct = 'STILL LIVE via direct GET';
      stillLive++;
    } catch (e) {
      direct = /404/.test(e.message) ? '404 (gone)' : `error: ${e.message}`;
    }
    console.log(`  ${r.sid}  ${r.title}  [synced ${r.synced}, ${r.grades} grades, ${r.mastery} mastery]  -> ${direct}`);
  }
}

console.log(`\n${missing} local row(s) missing from REST lists; ${stillLive} still live via direct GET.`);
console.log(stillLive ? 'PARITY DIFFERS: some missing rows still exist in Schoology' : 'PARITY OK: every missing row is gone from Schoology');
process.exit(stillLive ? 1 : 0);
