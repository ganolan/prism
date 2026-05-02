import { Router } from 'express';
import { getDb } from '../db/index.js';
import { getGradingScalesMap } from '../db/scales.js';
import { apiGet } from '../services/schoology.js';
import { syncSectionData } from '../services/sync.js';

const router = Router();

// GET /api/courses — list all courses (non-archived and visible by default)
router.get('/', (req, res) => {
  const db = getDb();
  const { view } = req.query;

  let rows;
  if (view === 'current') {
    rows = db.prepare('SELECT * FROM courses WHERE archived = 0 AND hidden = 0 ORDER BY course_name').all();
  } else if (view === 'archived') {
    rows = db.prepare('SELECT * FROM courses WHERE archived = 1 AND hidden = 0 ORDER BY course_name').all();
  } else {
    // Legacy behaviour — keep for backwards compatibility
    const includeArchived = req.query.archived === 'true';
    const includeHidden = req.query.hidden === 'true';
    let query = 'SELECT * FROM courses WHERE 1=1';
    if (!includeArchived) query += ' AND archived = 0';
    if (!includeHidden) query += ' AND hidden = 0';
    query += ' ORDER BY course_name';
    rows = db.prepare(query).all();
  }

  res.json(rows);
});

// GET /api/courses/:id — course detail with student count
router.get('/:id', (req, res) => {
  const db = getDb();
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!course) return res.status(404).json({ error: 'Course not found' });

  const studentCount = db.prepare(
    'SELECT COUNT(*) as count FROM enrolments WHERE course_id = ?'
  ).get(req.params.id).count;

  res.json({ ...course, studentCount });
});

// GET /api/courses/:id/students — students enrolled with their grades summary
router.get('/:id/students', (req, res) => {
  const db = getDb();
  const students = db.prepare(`
    SELECT s.*, e.id as enrolment_id
    FROM students s
    JOIN enrolments e ON e.student_id = s.id
    WHERE e.course_id = ?
    ORDER BY s.last_name, s.first_name
  `).all(req.params.id);

  // Get grade summary per student for this course (published assignments only)
  const gradeSummary = db.prepare(`
    SELECT g.student_id,
           COUNT(g.id) as graded_count,
           ROUND(AVG(CASE WHEN g.score IS NOT NULL AND g.max_score > 0 THEN (g.score * 100.0 / g.max_score) END), 1) as avg_pct
    FROM grades g
    JOIN assignments a ON a.id = g.assignment_id
    WHERE a.course_id = ? AND a.published = 1
    GROUP BY g.student_id
  `).all(req.params.id);

  const summaryMap = Object.fromEntries(gradeSummary.map(s => [s.student_id, s]));

  const enriched = students.map(s => ({
    ...s,
    graded_count: summaryMap[s.id]?.graded_count || 0,
    avg_pct: summaryMap[s.id]?.avg_pct || null,
  }));

  res.json(enriched);
});

// GET /api/courses/:id/assignments — assignments for a course (published only)
router.get('/:id/assignments', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT a.* FROM assignments a
    LEFT JOIN folders f ON f.schoology_folder_id = a.folder_id AND f.course_id = a.course_id
    LEFT JOIN folders fp ON fp.schoology_folder_id = f.parent_id AND fp.course_id = f.course_id AND f.parent_id != '0'
    WHERE a.course_id = ? AND a.published = 1
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
  res.json(rows);
});

// GET /api/courses/:id/gradebook — full gradebook grid (students x assignments)
router.get('/:id/gradebook', (req, res) => {
  const db = getDb();

  const assignments = db.prepare(`
    SELECT a.id, a.title, a.max_points, a.due_date, a.grading_category_id, a.grading_scale_id, a.folder_id,
           a.schoology_assignment_id,
           CASE WHEN EXISTS (
             SELECT 1 FROM mastery_alignments ma WHERE ma.assignment_schoology_id = a.schoology_assignment_id
             UNION
             SELECT 1 FROM mastery_scores ms WHERE ms.assignment_schoology_id = a.schoology_assignment_id
           ) THEN 1 ELSE 0 END AS aligned
    FROM assignments a
    LEFT JOIN folders f ON f.schoology_folder_id = a.folder_id AND f.course_id = a.course_id
    LEFT JOIN folders fp ON fp.schoology_folder_id = f.parent_id AND fp.course_id = f.course_id AND f.parent_id != '0'
    WHERE a.course_id = ? AND a.published = 1
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

  const students = db.prepare(`
    SELECT s.id, s.first_name, s.last_name, s.preferred_name, s.preferred_name_teacher
    FROM students s
    JOIN enrolments e ON e.student_id = s.id
    WHERE e.course_id = ?
    ORDER BY s.last_name, s.first_name
  `).all(req.params.id);

  const grades = db.prepare(`
    SELECT g.student_id, g.assignment_id, g.score, g.max_score, g.grade_comment, g.exception, g.late, g.draft, g.comment_status
    FROM grades g
    JOIN assignments a ON a.id = g.assignment_id
    WHERE a.course_id = ?
  `).all(req.params.id);

  // Index grades by student_id -> assignment_id
  const gradeMap = {};
  for (const g of grades) {
    if (!gradeMap[g.student_id]) gradeMap[g.student_id] = {};
    gradeMap[g.student_id][g.assignment_id] = g;
  }

  res.json({ assignments, students, grades: gradeMap, grading_scales: getGradingScalesMap() });
});

// POST /api/courses/import — fetch a past course from Schoology and sync it
router.post('/import', async (req, res) => {
  const { sectionId } = req.body;
  if (!sectionId) return res.status(400).json({ error: 'sectionId required' });

  try {
    const [sec, periodsData] = await Promise.all([
      apiGet(`/sections/${sectionId}`),
      apiGet(`/sections/${sectionId}/grading_periods`),
    ]);

    const gradingPeriod = periodsData?.grading_period?.[0]?.title || null;
    const now = new Date().toISOString();
    const db = getDb();

    db.prepare(`
      INSERT INTO courses (schoology_section_id, course_name, section_name, course_code, section_school_code, grading_period, archived, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(schoology_section_id) DO UPDATE SET
        course_name = excluded.course_name,
        section_name = excluded.section_name,
        course_code = excluded.course_code,
        section_school_code = excluded.section_school_code,
        grading_period = excluded.grading_period,
        archived = 1,
        synced_at = excluded.synced_at
    `).run(
      String(sec.id), sec.course_title, sec.section_title,
      sec.course_code || null, sec.section_school_code || null,
      gradingPeriod, now
    );

    const courseRow = db.prepare('SELECT * FROM courses WHERE schoology_section_id = ?').get(String(sec.id));
    const { studentsCount, assignmentsCount, gradesCount } = await syncSectionData(db, String(sec.id), courseRow.id, now);

    res.json({ course: courseRow, studentsCount, assignmentsCount, gradesCount });
  } catch (err) {
    if (err.message.includes('403')) return res.status(403).json({ error: 'Section not accessible — check the section ID and try again' });
    if (err.message.includes('404')) return res.status(404).json({ error: 'Section not found — check the section ID and try again' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/courses/:id/archive — toggle archive status
router.put('/:id/archive', (req, res) => {
  const db = getDb();
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const newState = course.archived ? 0 : 1;
  db.prepare('UPDATE courses SET archived = ? WHERE id = ?').run(newState, req.params.id);
  res.json({ ...course, archived: newState });
});

// PUT /api/courses/:id/visibility — toggle visibility
router.put('/:id/visibility', (req, res) => {
  const db = getDb();
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const newState = course.hidden ? 0 : 1;
  db.prepare('UPDATE courses SET hidden = ? WHERE id = ?').run(newState, req.params.id);
  res.json({ ...course, hidden: newState });
});

// PUT /api/courses/:id — update editable course fields
router.put('/:id', (req, res) => {
  const db = getDb();
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const { block_number } = req.body;
  db.prepare('UPDATE courses SET block_number = ? WHERE id = ?').run(
    block_number !== undefined ? block_number : course.block_number,
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id));
});

export default router;
