/**
 * probe-grades-per-assignment.js: does the public grades read filter to one task?
 *
 * GET /sections/{id}/grades returns every grade in the section. The on-demand
 * score refresh (docs/superpowers/specs/2026-10-19-on-demand-submissions-design.md)
 * needs one task's grades for unaligned tasks. This reads the section once in full
 * and once with each candidate filter, and compares the rows for that task.
 * Read only. Prints counts and keys, never student data.
 *
 * Run from repo root: node scripts/probe-grades-per-assignment.js <sectionId> <assignmentId>
 */
import 'dotenv/config';
import { apiGet } from '../server/services/schoology.js';

const [sectionId, assignmentId] = process.argv.slice(2);
if (!sectionId || !assignmentId) {
  console.error('Usage: node scripts/probe-grades-per-assignment.js <sectionId> <assignmentId>');
  process.exit(1);
}

const rows = (data) => data?.grades?.grade || [];
const key = (g) => `${g.enrollment_id}:${g.assignment_id}:${g.grade}:${g.comment ?? ''}:${g.exception ?? ''}:${g.timestamp}`;

const timed = async (path) => {
  const t = Date.now();
  const data = await apiGet(path);
  return { data, ms: Date.now() - t };
};

const full = await timed(`/sections/${sectionId}/grades`);
const all = rows(full.data);
const wanted = all.filter((g) => String(g.assignment_id) === String(assignmentId));
console.log(`full read: ${all.length} rows, ${wanted.length} for the task, ${full.ms} ms`);
console.log(`top-level keys: ${Object.keys(full.data || {}).join(', ')}`);
console.log(`grades keys: ${Object.keys(full.data?.grades || {}).join(', ')}`);
if (all[0]) console.log(`row keys: ${Object.keys(all[0]).join(', ')}`);

for (const q of [`assignment_id=${assignmentId}`, `assignment_ids=${assignmentId}`]) {
  const r = await timed(`/sections/${sectionId}/grades?${q}`);
  const got = rows(r.data);
  const others = got.filter((g) => String(g.assignment_id) !== String(assignmentId)).length;
  const wantedKeys = new Set(wanted.map(key));
  const same = got.length - others === wanted.length && got.every((g) => String(g.assignment_id) !== String(assignmentId) || wantedKeys.has(key(g)));
  console.log(`?${q}: ${got.length} rows, ${others} for other tasks, task rows identical to the full read: ${same}, ${r.ms} ms`);
}
