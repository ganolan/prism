/**
 * archivedCourses.js
 *
 * The teacher's archived (past) sections, through public REST (#178):
 * GET /users/{me}/sections?include_past=1 lists every section the teacher holds, past
 * (`active: 0`) and current. It needs no saved session. Schoology's own /courses/mycourses/past
 * page, which Prism scraped before (#5, #141), leaves out linked sections: in 2023-24 it listed
 * AI & ML 4(A-B) but not 6(A-B), linked to it (verified 2026-10-23).
 *
 * Linked sections share one set of tasks (the same Schoology task ids) and keep their own
 * students and grades. Prism holds a linked set as one course: the parent section's row in
 * `courses`, with each child in `linked_sections`. So a child section here joins its parent's row
 * (`linkedSectionIds`) and is never a row of its own, unless its parent is not a past section.
 */
import { apiGet } from './schoology.js';

const isPast = (s) => Number(s.active) === 0;
const parentOf = (s) => (s.parent_id && String(s.parent_id) !== '0' ? String(s.parent_id) : null);

// GET /users/{me}/sections?include_past=1 → the raw section rows (past and current).
async function teacherSections(get) {
  const me = await get('/users/me');
  const data = await get(`/users/${String(me.id || me.uid)}/sections?include_past=1`);
  return data?.section || [];
}

/**
 * The past sections as import rows, a linked set as one row: { sectionId, courseTitle, courseCode
 * (null when empty: a template), sectionTitle (the parent's, then each child's, joined with ", "),
 * gradingPeriodId (the section's first), linkedSectionIds }. Pure.
 */
export function groupPastSections(sections) {
  const past = sections.filter(isPast);
  const parents = new Set(past.filter((s) => !parentOf(s)).map((s) => String(s.id)));
  const rows = new Map();
  for (const s of past) {
    if (parents.has(parentOf(s))) continue;
    rows.set(String(s.id), {
      sectionId: String(s.id),
      courseTitle: s.course_title || null,
      courseCode: s.course_code || null,
      sectionTitle: s.section_title || null,
      gradingPeriodId: s.grading_periods?.[0] ?? null,
      linkedSectionIds: [],
    });
  }
  for (const s of past) {
    const row = rows.get(parentOf(s));
    if (!row) continue;
    row.linkedSectionIds.push(String(s.id));
    row.sectionTitle = [row.sectionTitle, s.section_title].filter(Boolean).join(', ');
  }
  return [...rows.values()];
}

// Grading period titles do not change: read each once per process.
const periodTitles = new Map();

async function periodTitle(get, id) {
  if (id == null) return null;
  const key = String(id);
  if (!periodTitles.has(key)) {
    try {
      periodTitles.set(key, (await get(`/gradingperiods/${key}`))?.title || null);
    } catch {
      return null; // not cached: a later read tries again
    }
  }
  return periodTitles.get(key);
}

/**
 * The teacher's archived sections: { sectionId, courseTitle, courseCode, sectionTitle,
 * gradingPeriod (its title, e.g. "2023-2024: 08/15/23 - 06/14/24", or null), linkedSectionIds },
 * or null when Schoology cannot be read (the caller reports discovery as unavailable). Never throws.
 * @param {{ get?: (path: string) => Promise<object> }} [deps]  test seam
 */
export async function getArchivedSections({ get = apiGet } = {}) {
  let sections;
  try {
    sections = await teacherSections(get);
  } catch {
    return null;
  }
  const rows = [];
  for (const { gradingPeriodId, ...row } of groupPastSections(sections)) {
    rows.push({ ...row, gradingPeriod: await periodTitle(get, gradingPeriodId) });
  }
  return rows;
}

/**
 * The sections linked to `parentId` (past or current): [{ sectionId, sectionTitle }]. Throws when
 * Schoology cannot be read: an import must not go on without them.
 */
export async function linkedSectionsOf(parentId, { get = apiGet } = {}) {
  return (await teacherSections(get))
    .filter((s) => parentOf(s) === String(parentId))
    .map((s) => ({ sectionId: String(s.id), sectionTitle: s.section_title || null }));
}

