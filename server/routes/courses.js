import { Router } from 'express';
import { getDb } from '../db/index.js';
import { getGradingScalesMap } from '../db/scales.js';
import { apiGet } from '../services/schoology.js';
import { finalizeArchivedCourse, enrichStudentProfiles } from '../services/sync.js';
import { isResubmitted } from '../lib/resubmission.js';
import { getArchivedSections } from '../services/archivedCourses.js';
import { syncBlockNumbers } from '../services/blockNumberSync.js';

const router = Router();
let blockSyncInProgress = false;

// GET /api/courses/archived/discover — enumerate archived (past) sections by
// scraping Schoology's /courses/mycourses/past source page (browser session).
// Annotates each with whether it's already imported and whether it lacks a
// course code. The two-segment path can't be captured by `/:id`. "Archived" is
// the app term; "past" only names Schoology's page (see CONTEXT.md). Issue #5.
router.get('/archived/discover', async (req, res) => {
  let sections;
  try {
    sections = await getArchivedSections();
  } catch {
    return res.status(500).json({ error: 'Could not check for archived courses' });
  }
  if (!sections) return res.json({ available: false, reason: 'no_session' });

  const db = getDb();
  // sectionId from the scraper / DB may be numeric or string — compare as strings.
  const known = new Set(
    db.prepare('SELECT schoology_section_id FROM courses').all().map((r) => String(r.schoology_section_id))
  );
  const annotated = sections.map((s) => ({
    ...s,
    imported: known.has(String(s.sectionId)),
    noCourseCode: !s.courseCode,
  }));
  res.json({ available: true, sections: annotated });
});

// GET /api/courses — list all courses (non-archived and visible by default)
router.get('/', (req, res) => {
  const db = getDb();
  const { view } = req.query;

  // Each row carries student_count (enrolment count) so callers can hide empty
  // shells like the master/template course without an extra round-trip.
  const select = 'SELECT *, (SELECT COUNT(*) FROM enrolments WHERE course_id = courses.id) AS student_count FROM courses';

  let rows;
  if (view === 'current') {
    rows = db.prepare(`${select} WHERE archived = 0 AND hidden = 0 ORDER BY course_name`).all();
  } else if (view === 'archived') {
    rows = db.prepare(`${select} WHERE archived = 1 AND hidden = 0 ORDER BY course_name`).all();
  } else {
    // Legacy behaviour — keep for backwards compatibility
    const includeArchived = req.query.archived === 'true';
    const includeHidden = req.query.hidden === 'true';
    let query = `${select} WHERE 1=1`;
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

  // Get grade summary per student for this course (published assignments
  // only). Assignments individually targeted at other students are excluded
  // from this student's averages and counts — see #54.
  const gradeSummary = db.prepare(`
    SELECT g.student_id,
           COUNT(g.id) as graded_count,
           ROUND(AVG(CASE WHEN g.score IS NOT NULL AND g.max_score > 0 THEN (g.score * 100.0 / g.max_score) END), 1) as avg_pct
    FROM grades g
    JOIN assignments a ON a.id = g.assignment_id
    JOIN students s ON s.id = g.student_id
    WHERE a.course_id = ? AND a.published = 1
      AND (
        a.num_assignees IS NULL OR a.num_assignees = 0
        OR EXISTS (
          SELECT 1 FROM assignment_assignees aa
          WHERE aa.assignment_id = a.id AND aa.schoology_uid = s.schoology_uid
        )
      )
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
           a.schoology_assignment_id, a.num_assignees, a.is_lti_submission,
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
    SELECT s.id, s.schoology_uid, s.first_name, s.last_name, s.preferred_name, s.preferred_name_teacher
    FROM students s
    JOIN enrolments e ON e.student_id = s.id
    WHERE e.course_id = ?
    ORDER BY s.last_name, s.first_name
  `).all(req.params.id);

  // Per-assignment relevance for individually-targeted assignments (#54).
  // `assignees` on each assignment is an array of internal student.id values
  // enrolled in this course who the assignment targets; absent/null means
  // open-to-all. Columns relevant to zero enrolled students are dropped
  // (they only exist in the course shell, not for the current roster).
  const uidToStudentId = {};
  for (const s of students) {
    if (s.schoology_uid) uidToStudentId[s.schoology_uid] = s.id;
  }
  const assigneeRows = db.prepare(`
    SELECT aa.assignment_id, aa.schoology_uid
    FROM assignment_assignees aa
    JOIN assignments a ON a.id = aa.assignment_id
    WHERE a.course_id = ?
  `).all(req.params.id);
  const assigneesByAssignment = {};
  for (const r of assigneeRows) {
    const studentId = uidToStudentId[r.schoology_uid];
    if (!studentId) continue;
    if (!assigneesByAssignment[r.assignment_id]) assigneesByAssignment[r.assignment_id] = [];
    assigneesByAssignment[r.assignment_id].push(studentId);
  }
  const filteredAssignments = [];
  for (const a of assignments) {
    if (a.num_assignees && a.num_assignees > 0) {
      const list = assigneesByAssignment[a.id] || [];
      if (list.length === 0) continue;
      a.assignees = list;
    }
    delete a.num_assignees;
    filteredAssignments.push(a);
  }

  const grades = db.prepare(`
    SELECT g.student_id, g.assignment_id, g.score, g.max_score, g.grade_comment, g.exception, g.late, g.draft, g.submitted_at, g.latest_revision_at, g.submission_type, g.lti_submission_state, g.comment_status
    FROM grades g
    JOIN assignments a ON a.id = g.assignment_id
    WHERE a.course_id = ?
  `).all(req.params.id);

  // Submission-scoped 'resubmit requested' flags (#49, Part A). Prism-local.
  const resubmitFlags = db.prepare(`
    SELECT f.student_id, f.assignment_id
    FROM flags f
    JOIN assignments a ON a.id = f.assignment_id
    WHERE a.course_id = ? AND f.flag_type = 'resubmit_requested' AND f.resolved = 0
  `).all(req.params.id);
  const resubmitSet = new Set(resubmitFlags.map(f => `${f.student_id}:${f.assignment_id}`));

  // Unresolved 'review needed' flags (#57). Prism-local — surfaced on the
  // gradebook rubric modal alongside submission status.
  const reviewFlags = db.prepare(`
    SELECT f.id, f.student_id, f.assignment_id, f.flag_reason
    FROM flags f
    JOIN assignments a ON a.id = f.assignment_id
    WHERE a.course_id = ? AND f.flag_type = 'review_needed' AND f.resolved = 0
  `).all(req.params.id);
  const reviewByKey = {};
  for (const f of reviewFlags) {
    const key = `${f.student_id}:${f.assignment_id}`;
    if (!reviewByKey[key]) reviewByKey[key] = [];
    reviewByKey[key].push({ id: f.id, flag_reason: f.flag_reason });
  }

  // Index grades by student_id -> assignment_id
  const gradeMap = {};
  for (const g of grades) {
    if (!gradeMap[g.student_id]) gradeMap[g.student_id] = {};
    g.resubmit_requested = resubmitSet.has(`${g.student_id}:${g.assignment_id}`);
    g.resubmitted = isResubmitted(g);
    g.review_needed = reviewByKey[`${g.student_id}:${g.assignment_id}`] || [];
    gradeMap[g.student_id][g.assignment_id] = g;
  }

  // Folder metadata for this course — lets the client group assignments by
  // their Schoology folder (Assessments tab, #22). Ordering of assignments
  // already follows folder display_weight; this just supplies the titles.
  const folders = db.prepare(`
    SELECT schoology_folder_id, title, parent_id, display_weight
    FROM folders
    WHERE course_id = ?
  `).all(req.params.id);

  res.json({ assignments: filteredAssignments, students, grades: gradeMap, folders, grading_scales: getGradingScalesMap() });
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
    const { studentsCount, assignmentsCount, gradesCount } =
      await finalizeArchivedCourse(db, { courseId: courseRow.id, sectionId: String(sec.id), now, runMastery: true });
    // Bring the imported section's students to full parity (email + guardians).
    const sectionStudents = db.prepare(`
      SELECT s.id, s.schoology_uid FROM students s
      JOIN enrolments e ON e.student_id = s.id
      WHERE e.course_id = ? AND s.schoology_uid IS NOT NULL
    `).all(courseRow.id);
    await enrichStudentProfiles(db, sectionStudents, now);

    res.json({ course: courseRow, studentsCount, assignmentsCount, gradesCount });
  } catch (err) {
    if (err.message.includes('403')) return res.status(403).json({ error: 'Section not accessible — check the section ID and try again' });
    if (err.message.includes('404')) return res.status(404).json({ error: 'Section not found — check the section ID and try again' });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/courses/sync-block-numbers — populate courses.block_number from
// PowerSchool's attendance "Block N" (the period name) via the shared browser
// session. Body: { courseIds?: number[] } to scope; default = current courses.
router.post('/sync-block-numbers', async (req, res) => {
  if (blockSyncInProgress) {
    return res.status(409).json({ error: 'Block-number sync already in progress' });
  }
  blockSyncInProgress = true;
  try {
    const courseIds = Array.isArray(req.body?.courseIds) ? req.body.courseIds : undefined;
    const summary = await syncBlockNumbers({
      courseIds,
      onProgress: (p) => console.log(`[block sync] ${p.message}`),
    });
    res.json(summary);
  } catch (err) {
    console.error('[block sync] Error:', err);
    const login = /log in|mastery:login|not logged in/i.test(err.message);
    res.status(login ? 401 : 500).json({ error: err.message });
  } finally {
    blockSyncInProgress = false;
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
