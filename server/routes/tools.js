import { Router } from 'express';
import { getDb } from '../db/index.js';
import { loadClassRoster, parseRosterFilters, applyRosterFilters, rosterFacets } from '../services/classRoster.js';
import { classEmails, NAME_FIELDS, pick } from '../services/classEmails.js';

const router = Router();

// Course IDs arrive as a comma-separated list in the :courseId param so the
// tools can span multiple selected courses. Returns [ids, "?,?,?"] for IN (...).
function parseCourseIds(param) {
  const ids = String(param).split(',').filter(Boolean);
  return [ids, ids.map(() => '?').join(',')];
}

// The selected courses' students, once each, ordered by surname, narrowed by the
// query's filters (gender, grade, level: services/classRoster.js, #73).
function filteredRoster(db, req) {
  const [courseIds] = parseCourseIds(req.params.courseId);
  return applyRosterFilters(loadClassRoster(db, courseIds), parseRosterFilters(req.query));
}

// GET /api/tools/filters/:courseId — what the roster filters can choose from (#73):
// { total, matched, facets: { gender, grade, level: [{ value, count }] } }, 'none' = no
// value. Facets count the whole roster; matched counts the students the query's filters keep.
router.get('/filters/:courseId', (req, res) => {
  const [courseIds] = parseCourseIds(req.params.courseId);
  const students = loadClassRoster(getDb(), courseIds);
  const matched = applyRosterFilters(students, parseRosterFilters(req.query)).length;
  res.json({ total: students.length, matched, facets: rosterFacets(students) });
});

// GET /api/tools/emails/:courseId — email list for one or more courses
// :courseId is a comma-separated list of course IDs.
// Query params: type=student|parent|both (default: student), and the roster filters, or
// students=1,2,3 (local student ids, those enrolled in the courses; the filters are then ignored).
// The work is services/classEmails.js, shared with the roster's Copy emails pop-up (#160).
router.get('/emails/:courseId', (req, res) => {
  const [courseIds] = parseCourseIds(req.params.courseId);
  const studentIds = req.query.students == null ? null
    : String(req.query.students).split(',').map(Number).filter(Number.isInteger);
  res.json(classEmails(getDb(), courseIds, {
    type: req.query.type || 'student',
    filters: parseRosterFilters(req.query),
    studentIds,
  }));
});

// GET /api/tools/random/:courseId?count=1 — random name picker
// :courseId is a comma-separated list of course IDs; the roster filters apply.
router.get('/random/:courseId', (req, res) => {
  const db = getDb();
  const count = Math.max(1, parseInt(req.query.count) || 1);
  const students = filteredRoster(db, req).map(s => pick(s, NAME_FIELDS));

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
// :courseId is a comma-separated list of course IDs; the roster filters apply.
router.get('/groups/:courseId', (req, res) => {
  const db = getDb();
  const groupCount = Math.max(2, parseInt(req.query.count) || 4);
  const balanced = req.query.balanced === 'true';

  // Balance uses standards-based mastery proficiency, NOT raw assignment scores:
  // avg_pct, the simple (unweighted) average of a student's category-level
  // rollups across the selected course(s) (services/classRoster.js). Overrides
  // are ignored — we use the synced grade_percentage. avg_pct is null when a
  // student has no proficiency data yet, and those students are placed randomly below.
  const students = filteredRoster(db, req).map(s => pick(s, [...NAME_FIELDS, 'avg_pct']));

  if (balanced && students.some(s => s.avg_pct != null)) {
    const groups = Array.from({ length: groupCount }, () => []);

    // Students with proficiency data: snake-draft by mastery (descending) so
    // each group ends up with a comparable average.
    const graded = students.filter(s => s.avg_pct != null).sort((a, b) => b.avg_pct - a.avg_pct);
    let direction = 1;
    let idx = 0;
    for (const s of graded) {
      groups[idx].push(s);
      idx += direction;
      if (idx >= groupCount) { idx = groupCount - 1; direction = -1; }
      else if (idx < 0) { idx = 0; direction = 1; }
    }

    // Students with no proficiency data: shuffle, then drop each into the
    // smallest group — spread randomly without skewing group sizes.
    const ungraded = students.filter(s => s.avg_pct == null);
    for (let i = ungraded.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ungraded[i], ungraded[j]] = [ungraded[j], ungraded[i]];
    }
    for (const s of ungraded) {
      const smallest = groups.reduce((min, g) => (g.length < min.length ? g : min), groups[0]);
      smallest.push(s);
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

// GET /api/tools/roster/:courseId — plain student roster for the class-list tool
// :courseId is a comma-separated list of course IDs. Returns the raw name fields
// rather than a rendered name: the client owns the formatting (see
// client/src/lib/nameFormats.js) so switching format needs no round trip. The
// roster filters apply.
router.get('/roster/:courseId', (req, res) => {
  const students = filteredRoster(getDb(), req).map(s => pick(s, NAME_FIELDS));

  res.json({ students, count: students.length });
});

export default router;
