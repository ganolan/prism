import { Router } from 'express';
import { getDb } from '../db/index.js';

const router = Router();

// GET /api/tools/emails/:courseId — email list for a course
// Query params: type=student|parent|both (default: student)
router.get('/emails/:courseId', (req, res) => {
  const db = getDb();
  const type = req.query.type || 'student';

  const students = db.prepare(`
    SELECT s.first_name, s.last_name, s.preferred_name, s.email, s.parent_email
    FROM students s
    JOIN enrolments e ON e.student_id = s.id
    WHERE e.course_id = ?
    ORDER BY s.last_name, s.first_name
  `).all(req.params.courseId);

  // Get parent emails from parents table (richer than legacy parent_email field)
  const parentEmails = db.prepare(`
    SELECT DISTINCT p.email
    FROM parents p
    JOIN enrolments e ON e.student_id = p.student_id
    WHERE e.course_id = ? AND p.email IS NOT NULL AND p.email != ''
    ORDER BY p.email
  `).all(req.params.courseId).map(r => r.email);

  let emails = [];
  if (type === 'student' || type === 'both') {
    emails = emails.concat(students.filter(s => s.email).map(s => s.email));
  }
  if (type === 'parent' || type === 'both') {
    // Prefer parents table, fall back to legacy parent_email
    if (parentEmails.length > 0) {
      emails = emails.concat(parentEmails);
    } else {
      emails = emails.concat(students.filter(s => s.parent_email).map(s => s.parent_email));
    }
  }

  // Outlook-friendly: semicolon-separated
  res.json({
    students,
    emails,
    formatted: emails.join('; '),
    count: emails.length,
  });
});

// GET /api/tools/random/:courseId?count=1 — random name picker
router.get('/random/:courseId', (req, res) => {
  const db = getDb();
  const count = Math.max(1, parseInt(req.query.count) || 1);

  const students = db.prepare(`
    SELECT s.id, s.first_name, s.last_name, s.preferred_name
    FROM students s
    JOIN enrolments e ON e.student_id = s.id
    WHERE e.course_id = ?
  `).all(req.params.courseId);

  // Fisher-Yates shuffle, take first N
  const shuffled = [...students];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  res.json({
    picked: shuffled.slice(0, Math.min(count, shuffled.length)),
    total: students.length,
  });
});

// GET /api/tools/groups/:courseId?count=4&balanced=false — group generator
router.get('/groups/:courseId', (req, res) => {
  const db = getDb();
  const groupCount = Math.max(2, parseInt(req.query.count) || 4);
  const balanced = req.query.balanced === 'true';

  let students = db.prepare(`
    SELECT s.id, s.first_name, s.last_name, s.preferred_name,
           (SELECT ROUND(AVG(CASE WHEN g.score IS NOT NULL AND g.max_score > 0
             THEN (g.score * 100.0 / g.max_score) END), 1)
            FROM grades g JOIN assignments a ON a.id = g.assignment_id
            WHERE g.student_id = s.id AND a.course_id = ?) as avg_pct
    FROM students s
    JOIN enrolments e ON e.student_id = s.id
    WHERE e.course_id = ?
  `).all(req.params.courseId, req.params.courseId);

  if (balanced && students.some(s => s.avg_pct != null)) {
    // Sort by grade descending, then distribute round-robin (serpentine)
    students.sort((a, b) => (b.avg_pct ?? 0) - (a.avg_pct ?? 0));
    const groups = Array.from({ length: groupCount }, () => []);
    let direction = 1;
    let idx = 0;
    for (const s of students) {
      groups[idx].push(s);
      idx += direction;
      if (idx >= groupCount) { idx = groupCount - 1; direction = -1; }
      else if (idx < 0) { idx = 0; direction = 1; }
    }
    res.json({ groups, balanced: true });
  } else {
    // Random shuffle, then deal into groups
    const shuffled = [...students];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const groups = Array.from({ length: groupCount }, () => []);
    shuffled.forEach((s, i) => groups[i % groupCount].push(s));
    res.json({ groups, balanced: false });
  }
});

export default router;
