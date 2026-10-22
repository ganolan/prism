// The Schoology sections of a Prism course (#178). A course is one section, or a set of linked
// sections: the parent is courses.schoology_section_id, each child a linked_sections row. Linked
// sections share one set of tasks and keep their own students and grades, so every read of the
// course reads each section.

// → [the course's own section, then each linked section in id order] (strings); [] for no course.
export function courseSectionIds(db, courseId) {
  const own = db.prepare('SELECT schoology_section_id AS id FROM courses WHERE id = ?').get(courseId);
  if (!own) return [];
  const linked = db.prepare('SELECT schoology_section_id AS id FROM linked_sections WHERE course_id = ? ORDER BY schoology_section_id')
    .all(courseId).map((r) => String(r.id));
  return [String(own.id), ...linked];
}

// → the Set of every section id Prism holds: each course's own and every linked section.
export function heldSectionIds(db) {
  return new Set(db.prepare(`SELECT schoology_section_id AS id FROM courses
    UNION SELECT schoology_section_id FROM linked_sections`).all().map((r) => String(r.id)));
}

// The course of linked sections that `sectionId` belongs to (as its own section or a linked one):
// { courseId }, or null for a section that is not in a linked set.
export function linkedCourseOf(db, sectionId) {
  const row = db.prepare(`SELECT course_id AS courseId FROM linked_sections WHERE schoology_section_id = ?
    UNION SELECT c.id FROM courses c WHERE c.schoology_section_id = ?
      AND EXISTS (SELECT 1 FROM linked_sections l WHERE l.course_id = c.id)`).get(String(sectionId), String(sectionId));
  return row ? { courseId: row.courseId } : null;
}

export class LinkedSectionWriteError extends Error {
  constructor(sectionId) {
    super(`Prism does not write to Schoology for linked sections (section ${sectionId}). Make this change in Schoology.`);
    this.code = 'LINKED_SECTION';
  }
}

// #178: Prism writes a course's changes to its own section, which for a student of a linked section
// is the wrong one. Until writes go to each student's section, every Schoology write to a linked
// set is refused (linked sets are past courses today, where nothing is graded).
export function assertSectionWritable(db, sectionId) {
  if (linkedCourseOf(db, sectionId)) throw new LinkedSectionWriteError(sectionId);
}
