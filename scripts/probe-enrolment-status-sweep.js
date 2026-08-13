/**
 * probe-enrolment-status-sweep.js — what `status` values does
 * /sections/{id}/enrollments actually emit across every section Prism tracks?
 *
 * Decides whether the sync fix should whitelist active statuses or blacklist
 * known-dropped ones. Also reports, per section, how many currently-stored
 * enrolments would be pruned — so we can eyeball the blast radius before
 * writing any delete path.
 *
 * Run from repo root: node scripts/probe-enrolment-status-sweep.js
 */
import 'dotenv/config';
import { getSectionEnrollments } from '../server/services/schoology.js';
import { getDb } from '../server/db/index.js';

const db = getDb();
const courses = db
  .prepare(
    `SELECT id, schoology_section_id, course_name, section_name, block_number, archived
     FROM courses WHERE archived = 0 AND excluded = 0 ORDER BY course_name, section_name`
  )
  .all();

console.log(`Sweeping ${courses.length} active, non-excluded courses…\n`);

const globalStatus = {};
const prunable = [];

for (const c of courses) {
  let enrollments;
  try {
    enrollments = await getSectionEnrollments(c.schoology_section_id);
  } catch (err) {
    console.log(`${c.course_name} ${c.section_name}: FETCH FAILED — ${err.message}`);
    continue;
  }

  const students = enrollments.filter((e) => String(e.admin) !== '1');
  const byStatus = {};
  for (const e of students) {
    const s = String(e.status);
    byStatus[s] = (byStatus[s] || 0) + 1;
    globalStatus[s] = (globalStatus[s] || 0) + 1;
  }

  // Which stored enrolments are NOT backed by an active (status 1) API row?
  const activeIds = new Set(students.filter((e) => String(e.status) === '1').map((e) => String(e.id)));
  const stored = db
    .prepare(
      `SELECT e.schoology_enrolment_id AS eid, s.first_name, s.last_name
       FROM enrolments e JOIN students s ON s.id = e.student_id WHERE e.course_id = ?`
    )
    .all(c.id);
  const stale = stored.filter((r) => !activeIds.has(String(r.eid)));

  const label = `[BK ${c.block_number ?? '?'}] ${c.course_name} ${c.section_name}`;
  console.log(
    `${label}\n   api students=${students.length} status=${JSON.stringify(byStatus)} stored=${stored.length} stale=${stale.length}`
  );
  for (const r of stale) {
    const apiRow = students.find((e) => String(e.id) === String(r.eid));
    console.log(
      `     - ${r.first_name} ${r.last_name} (enrolment ${r.eid}) → ${apiRow ? `status "${apiRow.status}"` : 'ABSENT from API response'}`
    );
    prunable.push({ course: label, name: `${r.first_name} ${r.last_name}`, status: apiRow?.status ?? 'absent' });
  }
}

console.log('\n================ SUMMARY ================');
console.log('Global student status distribution:', globalStatus);
console.log(`Total stale stored enrolments: ${prunable.length}`);
for (const p of prunable) console.log(`  ${p.course} — ${p.name} (${p.status})`);
