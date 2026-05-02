import { Router } from 'express';
import { getDb } from '../db/index.js';

const router = Router();

const EXCEPTION_CODES = {
  EXCUSED: 1,
  INCOMPLETE: 2,
  MISSING: 3,
  LATE: 4,
};

function normalizeException(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function isPastDue(dueDate) {
  if (!dueDate) return false;
  const due = new Date(dueDate);
  return !Number.isNaN(due.getTime()) && due < new Date();
}

function upsertFlag(db, { studentId, assignmentId, flagType, reason }) {
  const hasAssignment = assignmentId != null;
  const params = hasAssignment ? [studentId, flagType, assignmentId] : [studentId, flagType];
  const existing = db.prepare(
    `SELECT id, resolved FROM flags WHERE student_id = ? AND flag_type = ? AND ${hasAssignment ? 'assignment_id = ?' : 'assignment_id IS NULL'}`
  ).get(...params);

  if (existing) {
    db.prepare('UPDATE flags SET flag_reason = ?, resolved = 0, resolved_at = NULL WHERE id = ?')
      .run(reason, existing.id);
    return { created: false, reopened: Boolean(existing.resolved) };
  }

  const result = db.prepare(
    'INSERT INTO flags (student_id, assignment_id, flag_type, flag_reason) VALUES (?, ?, ?, ?)'
  ).run(studentId, assignmentId ?? null, flagType, reason);
  return { created: true, reopened: false, id: result.lastInsertRowid };
}

// GET /api/analytics/course/:id — class-level analytics
router.get('/course/:id', (req, res) => {
  const db = getDb();
  const courseId = req.params.id;

  // Get all assignments with their grade distributions (published only)
  const assignments = db.prepare(`
    SELECT a.id, a.schoology_assignment_id, a.title, a.due_date, a.max_points, a.folder_id
    FROM assignments a
    LEFT JOIN folders f ON f.schoology_folder_id = a.folder_id AND f.course_id = a.course_id
    LEFT JOIN folders fp ON fp.schoology_folder_id = f.parent_id AND fp.course_id = f.course_id AND f.parent_id != '0'
    WHERE a.course_id = ? AND a.max_points > 0 AND a.published = 1
    ORDER BY
      CASE WHEN a.folder_id IS NULL OR a.folder_id = '0' THEN a.display_weight
           WHEN f.parent_id IS NOT NULL AND f.parent_id != '0' THEN COALESCE(fp.display_weight, 0)
           ELSE COALESCE(f.display_weight, a.display_weight) END ASC,
      CASE WHEN a.folder_id IS NULL OR a.folder_id = '0' THEN 0
           WHEN f.parent_id IS NOT NULL AND f.parent_id != '0' THEN COALESCE(f.display_weight, 0)
           ELSE a.display_weight END ASC,
      CASE WHEN f.parent_id IS NOT NULL AND f.parent_id != '0' THEN a.display_weight ELSE 0 END ASC,
      a.title
  `).all(courseId);

  // An assignment is summative iff it is mastery-aligned (matches the rule
  // used by the student page and assessment page to decide when to render a
  // mastery rubric). Aligned = has a row in mastery_alignments OR mastery_scores.
  const alignedIds = new Set(
    db.prepare(`
      SELECT assignment_schoology_id AS sid FROM mastery_alignments
      UNION
      SELECT assignment_schoology_id AS sid FROM mastery_scores
    `).all().map(r => String(r.sid))
  );
  for (const a of assignments) {
    a.assignment_type = alignedIds.has(String(a.schoology_assignment_id)) ? 'summative' : 'formative';
  }

  // Distribution and trend charts only show summatives — formatives are graded
  // on different scales and aggregating them with summatives is not meaningful.
  const summativeAssignments = assignments.filter(a => a.assignment_type === 'summative');

  const distributions = [];
  for (const a of summativeAssignments) {
    const grades = db.prepare(`
      SELECT g.score, g.max_score, g.exception,
             (g.score * 100.0 / g.max_score) as pct
      FROM grades g
      WHERE g.assignment_id = ? AND g.score IS NOT NULL AND g.max_score > 0
    `).all(a.id);

    if (grades.length === 0) continue;

    const pcts = grades.map(g => g.pct).sort((a, b) => a - b);
    const n = pcts.length;
    const mean = pcts.reduce((s, v) => s + v, 0) / n;
    const variance = pcts.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
    const stdDev = Math.sqrt(variance);

    // Quartiles
    const q1 = percentile(pcts, 25);
    const median = percentile(pcts, 50);
    const q3 = percentile(pcts, 75);
    const iqr = q3 - q1;
    const whiskerLow = Math.max(pcts[0], q1 - 1.5 * iqr);
    const whiskerHigh = Math.min(pcts[n - 1], q3 + 1.5 * iqr);
    const outliers = pcts.filter(v => v < whiskerLow || v > whiskerHigh);

    distributions.push({
      assignment_id: a.id,
      title: a.title,
      due_date: a.due_date,
      assignment_type: a.assignment_type,
      max_points: a.max_points,
      count: n,
      mean: round(mean),
      stdDev: round(stdDev),
      min: round(pcts[0]),
      q1: round(q1),
      median: round(median),
      q3: round(q3),
      max: round(pcts[n - 1]),
      whiskerLow: round(whiskerLow),
      whiskerHigh: round(whiskerHigh),
      outliers: outliers.map(round),
    });
  }

  // Class average trend (running average across assignments in date order)
  const trend = distributions.map(d => ({
    title: d.title,
    due_date: d.due_date,
    mean: d.mean,
    stdDev: d.stdDev,
    assignment_type: d.assignment_type,
  }));

  // Folder structure for grouping
  const folders = db.prepare(
    'SELECT schoology_folder_id, title, color FROM folders WHERE course_id = ? ORDER BY display_weight'
  ).all(courseId);

  res.json({ distributions, trend, folders });
});

// GET /api/analytics/student/:id — individual student analytics
router.get('/student/:id', (req, res) => {
  const db = getDb();
  const studentId = req.params.id;
  const threshold = parseFloat(req.query.threshold) || 15;

  // Get all grades with course info, ordered by Schoology display order (published only).
  // assignment_type is computed from mastery alignment (summative iff aligned),
  // matching the rule used by the student/assessment pages.
  const grades = db.prepare(`
    SELECT g.score, g.max_score, g.exception,
           a.id as assignment_id, a.schoology_assignment_id, a.title, a.due_date, a.max_points,
           CASE WHEN EXISTS (
             SELECT 1 FROM mastery_alignments ma WHERE ma.assignment_schoology_id = a.schoology_assignment_id
             UNION
             SELECT 1 FROM mastery_scores ms WHERE ms.assignment_schoology_id = a.schoology_assignment_id
           ) THEN 'summative' ELSE 'formative' END AS assignment_type,
           c.id as course_id, c.course_name,
           (CASE WHEN g.score IS NOT NULL AND g.max_score > 0 THEN (g.score * 100.0 / g.max_score) ELSE NULL END) as pct
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
  `).all(studentId);

  // Grade trends per course
  const byCourse = {};
  for (const g of grades) {
    if (!byCourse[g.course_id]) byCourse[g.course_id] = { course_name: g.course_name, grades: [] };
    byCourse[g.course_id].grades.push(g);
  }

  const trends = {};
  for (const [courseId, data] of Object.entries(byCourse)) {
    trends[courseId] = {
      course_name: data.course_name,
      points: data.grades.filter(g => g.pct != null).map(g => ({
        title: g.title,
        due_date: g.due_date,
        pct: round(g.pct),
        assignment_type: g.assignment_type,
      })),
    };
  }

  // Cross-course comparison
  const crossCourse = Object.entries(byCourse).map(([courseId, data]) => {
    const scored = data.grades.filter(g => g.pct != null);
    if (scored.length === 0) return null;
    const avg = scored.reduce((s, g) => s + g.pct, 0) / scored.length;
    return { course_id: parseInt(courseId), course_name: data.course_name, avg_pct: round(avg), count: scored.length };
  }).filter(Boolean);

  // Significant changes (consecutive assignments within same course)
  const alerts = [];
  for (const [courseId, data] of Object.entries(byCourse)) {
    const scored = data.grades.filter(g => g.pct != null);
    for (let i = 1; i < scored.length; i++) {
      const prev = scored[i - 1].pct;
      const curr = scored[i].pct;
      const change = curr - prev;
      if (Math.abs(change) >= threshold) {
        alerts.push({
          course_name: data.course_name,
          from: { title: scored[i - 1].title, pct: round(prev) },
          to: { title: scored[i].title, pct: round(curr) },
          change: round(change),
          direction: change > 0 ? 'improvement' : 'decline',
        });
      }
    }
  }

  res.json({ trends, crossCourse, alerts, threshold });
});

// POST /api/analytics/auto-flags/:courseId — run automated flag detection
router.post('/auto-flags/:courseId', (req, res) => {
  const db = getDb();
  const courseId = req.params.courseId;
  const threshold = parseFloat(req.body.threshold) || 15;
  const lowGradeThreshold = parseFloat(req.body.low_grade_threshold) || 50;

  const students = db.prepare(`
    SELECT s.id, s.first_name, s.last_name
    FROM students s JOIN enrolments e ON e.student_id = s.id
    WHERE e.course_id = ?
  `).all(courseId);

  const created = [];

  for (const student of students) {
    const grades = db.prepare(`
      SELECT g.score, g.max_score, g.exception,
             a.id as assignment_id, a.title, a.due_date,
             (CASE WHEN g.score IS NOT NULL AND g.max_score > 0 THEN (g.score * 100.0 / g.max_score) ELSE NULL END) as pct
      FROM grades g
      JOIN assignments a ON a.id = g.assignment_id
      LEFT JOIN folders f ON f.schoology_folder_id = a.folder_id AND f.course_id = a.course_id
      LEFT JOIN folders fp ON fp.schoology_folder_id = f.parent_id AND fp.course_id = f.course_id AND f.parent_id != '0'
      WHERE g.student_id = ? AND a.course_id = ? AND a.published = 1
      ORDER BY
        CASE WHEN a.folder_id IS NULL OR a.folder_id = '0' THEN a.display_weight
             WHEN f.parent_id IS NOT NULL AND f.parent_id != '0' THEN COALESCE(fp.display_weight, 0)
             ELSE COALESCE(f.display_weight, a.display_weight) END ASC,
        CASE WHEN a.folder_id IS NULL OR a.folder_id = '0' THEN 0
             WHEN f.parent_id IS NOT NULL AND f.parent_id != '0' THEN COALESCE(f.display_weight, 0)
             ELSE a.display_weight END ASC,
        CASE WHEN f.parent_id IS NOT NULL AND f.parent_id != '0' THEN a.display_weight ELSE 0 END ASC,
        a.title
    `).all(student.id, courseId);

    // Check for missing/excused work
    const missing = grades.filter(g => {
      const exception = normalizeException(g.exception);
      if (exception === EXCEPTION_CODES.LATE) return false;
      if (exception === EXCEPTION_CODES.MISSING) return true;
      if (exception) return false;
      if (g.score != null) return false;
      return isPastDue(g.due_date);
    });
    for (const m of missing) {
      const result = upsertFlag(db, {
        studentId: student.id,
        assignmentId: m.assignment_id,
        flagType: 'missing',
        reason: m.title,
      });
      if (result.created) {
        created.push({ student: `${student.first_name} ${student.last_name}`, type: 'missing', assignment: m.title });
      }
    }

    const lateSubmissions = grades.filter(g => normalizeException(g.exception) === EXCEPTION_CODES.LATE);
    for (const l of lateSubmissions) {
      const result = upsertFlag(db, {
        studentId: student.id,
        assignmentId: l.assignment_id,
        flagType: 'late_submission',
        reason: l.title,
      });
      if (result.created) {
        created.push({ student: `${student.first_name} ${student.last_name}`, type: 'late_submission', assignment: l.title });
      }
    }

    // Check for significant drops between consecutive scored assignments
    const scored = grades.filter(g => g.pct != null);
    for (let i = 1; i < scored.length; i++) {
      const change = scored[i].pct - scored[i - 1].pct;
      if (change <= -threshold) {
        const exists = db.prepare(
          'SELECT id FROM flags WHERE student_id = ? AND assignment_id = ? AND flag_type = ? AND resolved = 0'
        ).get(student.id, scored[i].assignment_id, 'performance_change');
        if (!exists) {
          const reason = `${Math.abs(Math.round(change))}% drop: ${scored[i - 1].title} (${Math.round(scored[i - 1].pct)}%) -> ${scored[i].title} (${Math.round(scored[i].pct)}%)`;
          db.prepare('INSERT INTO flags (student_id, assignment_id, flag_type, flag_reason) VALUES (?, ?, ?, ?)')
            .run(student.id, scored[i].assignment_id, 'performance_change', reason);
          created.push({ student: `${student.first_name} ${student.last_name}`, type: 'performance_drop', reason });
        }
      }
    }

    // Check for grades below threshold
    const belowThreshold = scored.filter(g => g.pct < lowGradeThreshold);
    for (const g of belowThreshold) {
      const exists = db.prepare(
        'SELECT id FROM flags WHERE student_id = ? AND assignment_id = ? AND flag_type = ? AND resolved = 0'
      ).get(student.id, g.assignment_id, 'review_needed');
      if (!exists) {
        db.prepare('INSERT INTO flags (student_id, assignment_id, flag_type, flag_reason) VALUES (?, ?, ?, ?)')
          .run(student.id, g.assignment_id, 'review_needed', `Below ${lowGradeThreshold}%: ${g.title} (${Math.round(g.pct)}%)`);
        created.push({ student: `${student.first_name} ${student.last_name}`, type: 'low_grade', assignment: g.title });
      }
    }
  }

  res.json({ flagsCreated: created.length, details: created });
});

function percentile(sorted, p) {
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}

function round(v) {
  return Math.round(v * 10) / 10;
}

export default router;
