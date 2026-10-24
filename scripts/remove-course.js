#!/usr/bin/env node
/**
 * Remove one course from Prism's database, with everything that hangs off it: its tasks and every
 * row about them, its course-level rows, its enrolments, and each student who is left with no
 * enrolment in any course (with every row about that student). District-wide measurement topics and
 * reporting categories are kept, with their link to the course cleared. Schoology is not touched.
 *
 * Written for a section the teacher was only a member of (24 Oct 2026: MAD 3(A-B) 21-22, course
 * 1096, imported before discovery checked the admin role; server/lib/sectionRole.js). A student who
 * is also in another course keeps every row outside this course.
 *
 * Dry run by default: prints the row count per table. --apply deletes in one transaction and rolls
 * back if a foreign key check fails afterwards. Take a backup first (on prod:
 * `launchctl kickstart gui/$(id -u)/com.prism.backup`).
 *
 * Usage: DB_PATH=<db> node scripts/remove-course.js <courseId> [--apply]
 */
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';

// District-wide rows other sections share: their course_id only names an owner (schema.sql), so they
// are kept and the link to this course is cleared.
const SHARED = ['measurement_topics', 'reporting_categories'];

const columnsOf = (db, table) => db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map((c) => c.name);
const tablesOf = (db) => db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all().map((t) => t.name);

// → [{ table, sql, params }] in delete order (children before parents).
export function removalPlan(db, courseId) {
  const course = db.prepare('SELECT id, schoology_section_id, course_name FROM courses WHERE id = ?').get(courseId);
  if (!course) throw new Error(`no course ${courseId}`);
  const tables = tablesOf(db);
  const has = (t, c) => columnsOf(db, t).includes(c);
  const taskIds = db.prepare('SELECT id FROM assignments WHERE course_id = ?').all(courseId).map((r) => r.id);
  // Rows keyed by Schoology's task id (mastery scores, rubric levels): only ids no other course holds.
  const sgyTaskIds = db.prepare(`
    SELECT DISTINCT schoology_assignment_id AS id FROM assignments a
    WHERE a.course_id = ? AND schoology_assignment_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM assignments b WHERE b.schoology_assignment_id = a.schoology_assignment_id AND b.course_id <> ?)
  `).all(courseId, courseId).map((r) => r.id);
  const orphans = db.prepare(`
    SELECT s.id, s.schoology_uid FROM students s
    WHERE s.id IN (SELECT student_id FROM enrolments WHERE course_id = ?)
      AND NOT EXISTS (SELECT 1 FROM enrolments e WHERE e.student_id = s.id AND e.course_id <> ?)
  `).all(courseId, courseId);
  const list = (ids) => ids.map(() => '?').join(',');
  const steps = [];
  const add = (table, where, params) => { if (params.length) steps.push({ table, sql: `DELETE FROM ${table} WHERE ${where}`, params }); };

  for (const t of tables) {
    if (t === 'assignments') continue;
    for (const c of ['assignment_id', 'result_assignment_id']) if (has(t, c)) add(t, `${c} IN (${list(taskIds)})`, taskIds);
    if (has(t, 'assignment_schoology_id')) add(t, `assignment_schoology_id IN (${list(sgyTaskIds)})`, sgyTaskIds);
  }
  for (const t of tables) {
    if (['courses', 'assignments', 'enrolments'].includes(t)) continue;
    if (SHARED.includes(t)) {
      if (has(t, 'course_id')) steps.push({ table: t, sql: `UPDATE ${t} SET course_id = NULL WHERE course_id = ?`, params: [courseId], keep: true });
      continue;
    }
    if (has(t, 'course_id')) add(t, 'course_id = ?', [courseId]);
  }
  add('assignments', 'course_id = ?', [courseId]);
  add('enrolments', 'course_id = ?', [courseId]);
  const ids = orphans.map((s) => s.id);
  const uids = orphans.map((s) => s.schoology_uid).filter(Boolean);
  for (const t of tables) {
    if (['students', 'enrolments'].includes(t)) continue;
    if (has(t, 'student_id')) add(t, `student_id IN (${list(ids)})`, ids);
    if (has(t, 'student_uid')) add(t, `student_uid IN (${list(uids)})`, uids);
  }
  add('students', `id IN (${list(ids)})`, ids);
  add('courses', 'id = ?', [courseId]);
  return { course, taskIds, orphans, steps };
}

const countSql = (sql) => sql
  .replace(/^DELETE FROM/, 'SELECT COUNT(*) AS n FROM')
  .replace(/^UPDATE (\w+) SET course_id = NULL WHERE/, 'SELECT COUNT(*) AS n FROM $1 WHERE');

export function removeCourse(db, courseId, { apply = false } = {}) {
  const plan = removalPlan(db, courseId);
  const counts = plan.steps.map((s) => ({ table: s.keep ? `${s.table} (kept, course link cleared)` : s.table, rows: db.prepare(countSql(s.sql)).get(...s.params).n }));
  if (apply) {
    db.pragma('foreign_keys = ON');
    db.transaction(() => {
      for (const s of plan.steps) db.prepare(s.sql).run(...s.params);
      const broken = db.prepare('PRAGMA foreign_key_check').all();
      if (broken.length) throw new Error(`foreign key check failed: ${JSON.stringify(broken.slice(0, 5))}`);
    })();
  }
  return { course: plan.course, tasks: plan.taskIds.length, studentsRemoved: plan.orphans.length, counts: counts.filter((c) => c.rows > 0) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [id, flag] = process.argv.slice(2);
  if (!id || !process.env.DB_PATH) {
    console.error('Usage: DB_PATH=<db> node scripts/remove-course.js <courseId> [--apply]');
    process.exit(2);
  }
  const db = new Database(process.env.DB_PATH, { fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  const r = removeCourse(db, Number(id), { apply: flag === '--apply' });
  console.log(`${flag === '--apply' ? 'Removed' : 'Would remove'} course ${r.course.id} (${r.course.course_name}, section ${r.course.schoology_section_id}): ${r.tasks} tasks, ${r.studentsRemoved} students with no other course`);
  for (const c of r.counts) console.log(`  ${c.table}: ${c.rows}`);
}
