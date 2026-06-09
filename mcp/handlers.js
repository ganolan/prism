// Pure data handlers for PrisMCP tools. Each takes an open better-sqlite3 db
// and returns plain data; mcp/server.js wraps them in thin registerTool
// callbacks. Kept separate so they unit-test directly against a :memory: DB,
// mirroring the server/**/*.test.js pattern.

import { listRubrics, getRubricByName, saveRubric, findRubricByContentHash } from '../server/services/rubricStore.js';
import { hashRubricContent } from '../server/services/rubricHash.js';

// Active courses = not archived, not excluded, not hidden. Mirrors the
// 'current' view in server/routes/courses.js, plus the excluded filter (#56,
// spec §3.1).
export function listCourses(db) {
  return db.prepare(`
    SELECT id, course_name, section_name, course_code, schoology_section_id
    FROM courses
    WHERE archived = 0 AND excluded = 0 AND hidden = 0
    ORDER BY course_name
  `).all();
}

// Assignments for a course (local course id), so a phrase like "the MAD
// project I just collected" can resolve to a concrete assignment (spec §3.1).
export function listAssignments(db, { course_id }) {
  const rows = db.prepare(`
    SELECT a.id, a.schoology_assignment_id, a.title, a.due_date, a.assignment_type,
           EXISTS (
             SELECT 1 FROM mastery_alignments ma
             WHERE ma.assignment_schoology_id = a.schoology_assignment_id
               AND ma.course_id = a.course_id
           ) AS has_aligned_topics,
           (SELECT MAX(g.submitted_at) FROM grades g WHERE g.assignment_id = a.id) AS latest_submitted_at
    FROM assignments a
    WHERE a.course_id = ?
    ORDER BY a.due_date, a.id
  `).all(Number(course_id));
  return rows.map(({ latest_submitted_at, ...r }) => ({
    ...r,
    has_aligned_topics: !!r.has_aligned_topics,
    // submitted_at is a Unix-seconds epoch (0 = never submitted, #13/#62);
    // surface the latest as an ISO string, null when nobody has submitted.
    latest_submission_at: latest_submitted_at > 0 ? new Date(latest_submitted_at * 1000).toISOString() : null,
  }));
}

const LEVELS = ['ED', 'EX', 'D', 'EM', 'IE'];

// Portable rubric shape — ordered criteria, per-level descriptors, NO Prism ids
// (the JSON twin of exportRubricCsv; spec §6).
function toPortable(rubric) {
  return {
    name: rubric.name,
    criteria: rubric.criteria.map((c) => ({
      criterion_name: c.criterion_name,
      standard_title: c.standard_title,
      reporting_category: c.reporting_category,
      descriptors: Object.fromEntries(
        LEVELS.map((l) => [l, c.descriptors?.[l] ?? (l === 'IE' ? 'Insufficient Evidence' : null)])
      ),
    })),
  };
}

export function listRubricsTool(db) {
  // Name is the agent's handle — drop the local id.
  return listRubrics(db).map(({ name, source, criteria_count, updated_at }) =>
    ({ name, source, criteria_count, updated_at }));
}

export function readRubric(db, { name }) {
  const r = getRubricByName(db, name);
  return r ? toPortable(r) : null;
}

export function writeRubric(db, { name, criteria, on_name_conflict = 'prompt' }) {
  const content = { name, source: 'mcp', criteria: criteria.map((c, i) => ({ ...c, position: i + 1 })) };
  const criteria_count = criteria.length;

  const exact = findRubricByContentHash(db, hashRubricContent(content));
  if (exact) return { reused_existing: exact.name, match: 'exact', criteria_count };

  const named = getRubricByName(db, name);
  if (named) {
    if (on_name_conflict === 'update') { saveRubric(db, content, named.id); return { name, match: 'updated', criteria_count }; }
    if (on_name_conflict === 'new')    { saveRubric(db, content);          return { name, match: 'created_new', criteria_count }; }
    return {
      conflict: 'name',
      existing: name,
      existing_criteria_count: named.criteria.length,
      message: `A different rubric named "${name}" already exists. Re-call with on_name_conflict:"update" to replace it, or "new" to save a separate copy.`,
    };
  }

  saveRubric(db, content);
  return { name, match: 'created', criteria_count };
}
