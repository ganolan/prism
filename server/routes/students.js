import { Router } from 'express';
import { getDb } from '../db/index.js';

const router = Router();

// GET /api/students — list all students (optional search)
router.get('/', (req, res) => {
  const db = getDb();
  const { q } = req.query;
  let rows;
  if (q) {
    const like = `%${q}%`;
    rows = db.prepare(`
      SELECT * FROM students
      WHERE first_name LIKE ? OR last_name LIKE ? OR preferred_name LIKE ?
      ORDER BY last_name, first_name
    `).all(like, like, like);
  } else {
    rows = db.prepare('SELECT * FROM students ORDER BY last_name, first_name').all();
  }
  res.json(rows);
});

// GET /api/students/:id — student profile with courses, grades, notes, flags
router.get('/:id', (req, res) => {
  const db = getDb();
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if (!student) return res.status(404).json({ error: 'Student not found' });

  const courses = db.prepare(`
    SELECT c.*, e.id as enrolment_id
    FROM courses c
    JOIN enrolments e ON e.course_id = c.id
    WHERE e.student_id = ?
    ORDER BY c.course_name
  `).all(req.params.id);

  const grades = db.prepare(`
    SELECT g.*, a.title as assignment_title, a.due_date, a.max_points as assignment_max_points,
           a.grading_scale_id, a.display_weight, a.schoology_assignment_id,
           c.course_name, c.id as course_id
    FROM grades g
    JOIN assignments a ON a.id = g.assignment_id
    JOIN courses c ON c.id = a.course_id
    LEFT JOIN folders f ON f.schoology_folder_id = a.folder_id AND f.course_id = a.course_id
    LEFT JOIN folders fp ON fp.schoology_folder_id = f.parent_id AND fp.course_id = f.course_id AND f.parent_id != '0'
    WHERE g.student_id = ? AND a.published = 1
    ORDER BY
      CASE WHEN a.folder_id IS NULL OR a.folder_id = '0' THEN a.display_weight
           WHEN f.parent_id IS NOT NULL AND f.parent_id != '0' THEN COALESCE(fp.display_weight, 0)
           ELSE COALESCE(f.display_weight, a.display_weight) END ASC,
      CASE WHEN a.folder_id IS NULL OR a.folder_id = '0' THEN 0
           WHEN f.parent_id IS NOT NULL AND f.parent_id != '0' THEN COALESCE(f.display_weight, 0)
           ELSE a.display_weight END ASC,
      CASE WHEN f.parent_id IS NOT NULL AND f.parent_id != '0' THEN a.display_weight ELSE 0 END ASC,
      a.title
  `).all(req.params.id);

  // Attach per-assignment mastery topic data. An assignment is "aligned" if it
  // has at least one row in mastery_alignments (authoritative) OR mastery_scores
  // (fallback for pre-refactor data). For each aligned assignment we return the
  // union of its aligned topics with the student's grade on each.
  if (student.schoology_uid) {
    const alignmentRows = db.prepare(`
      SELECT ma.assignment_schoology_id, ma.topic_id,
             mt.title AS topic_title, mt.external_id AS topic_external_id, mt.category_id,
             rc.title AS category_title, rc.external_id AS category_external_id
      FROM mastery_alignments ma
      JOIN measurement_topics mt ON mt.id = ma.topic_id
      LEFT JOIN reporting_categories rc ON rc.id = mt.category_id
    `).all();
    const scoreRows = db.prepare(`
      SELECT ms.assignment_schoology_id, ms.topic_id, ms.grade, ms.points,
             mt.title AS topic_title, mt.external_id AS topic_external_id, mt.category_id,
             rc.title AS category_title, rc.external_id AS category_external_id
      FROM mastery_scores ms
      JOIN measurement_topics mt ON mt.id = ms.topic_id
      LEFT JOIN reporting_categories rc ON rc.id = mt.category_id
      WHERE ms.student_uid = ?
    `).all(student.schoology_uid);

    // assignment_schoology_id → Map<topic_id, row>
    const topicsByAssignment = new Map();
    const ensure = (aid) => {
      if (!topicsByAssignment.has(aid)) topicsByAssignment.set(aid, new Map());
      return topicsByAssignment.get(aid);
    };
    for (const a of alignmentRows) {
      ensure(String(a.assignment_schoology_id)).set(a.topic_id, {
        topic_id: a.topic_id, title: a.topic_title, external_id: a.topic_external_id,
        category_id: a.category_id, category_title: a.category_title, category_external_id: a.category_external_id,
        grade: null, points: null,
      });
    }
    for (const s of scoreRows) {
      const aid = String(s.assignment_schoology_id);
      const m = ensure(aid);
      const existing = m.get(s.topic_id) || {
        topic_id: s.topic_id, title: s.topic_title, external_id: s.topic_external_id,
        category_id: s.category_id, category_title: s.category_title, category_external_id: s.category_external_id,
        grade: null, points: null,
      };
      existing.grade = s.grade;
      existing.points = s.points;
      m.set(s.topic_id, existing);
    }

    for (const g of grades) {
      const aid = String(g.schoology_assignment_id);
      const map = topicsByAssignment.get(aid);
      g.mastery = map ? { topics: [...map.values()].sort((a, b) => (a.external_id || '').localeCompare(b.external_id || '')) } : null;
    }
  }

  const notes = db.prepare(
    'SELECT * FROM notes WHERE student_id = ? ORDER BY created_at DESC'
  ).all(req.params.id);

  const flags = db.prepare(
    'SELECT * FROM flags WHERE student_id = ? ORDER BY created_at DESC'
  ).all(req.params.id);

  const parents = db.prepare(
    'SELECT * FROM parents WHERE student_id = ? ORDER BY last_name, first_name'
  ).all(req.params.id);

  res.json({ ...student, courses, grades, notes, flags, parents });
});

// PUT /api/students/:id — update editable fields
router.put('/:id', (req, res) => {
  const db = getDb();
  const { preferred_name_teacher } = req.body;
  db.prepare(`
    UPDATE students SET preferred_name_teacher = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(preferred_name_teacher ?? null, req.params.id);
  const updated = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// PUT /api/students/:id/parents/:parentId — update a parent's phone number
router.put('/:id/parents/:parentId', (req, res) => {
  const db = getDb();
  const { phone } = req.body;
  const result = db.prepare(`UPDATE parents SET phone = ? WHERE id = ? AND student_id = ?`)
    .run(phone ?? null, req.params.parentId, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Parent not found' });
  const updated = db.prepare('SELECT * FROM parents WHERE id = ?').get(req.params.parentId);
  res.json(updated);
});

export default router;
