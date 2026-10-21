import { Router } from 'express';
import { getDb } from '../db/index.js';
import { preferredFirstName } from '../services/studentNames.js';
import { getFeatures } from '../middleware/featureGate.js';
import { contactsForStudents } from '../services/guardianContactStore.js';
import { emailKey } from '../lib/guardianContacts.js';

const router = Router();

// Course IDs arrive as a comma-separated list in the :courseId param so the
// tools can span multiple selected courses. Returns [ids, "?,?,?"] for IN (...).
function parseCourseIds(param) {
  const ids = String(param).split(',').filter(Boolean);
  return [ids, ids.map(() => '?').join(',')];
}

// GET /api/tools/emails/:courseId — email list for one or more courses
// :courseId is a comma-separated list of course IDs.
// Query params: type=student|parent|both (default: student)
// Answers `excluded`: guardians left out because PowerSchool does not clear them (#66).
router.get('/emails/:courseId', (req, res) => {
  const db = getDb();
  const type = req.query.type || 'student';
  const [courseIds, placeholders] = parseCourseIds(req.params.courseId);

  const rows = db.prepare(`
    SELECT s.id, s.first_name, s.last_name, s.preferred_name, s.preferred_name_teacher,
           s.email, s.parent_email
    FROM students s
    JOIN enrolments e ON e.student_id = s.id
    WHERE e.course_id IN (${placeholders}) AND e.dropped_at IS NULL
    ORDER BY s.last_name, s.first_name
  `).all(...courseIds);

  // Dedup students enrolled in more than one of the selected courses
  const seenStudent = new Set();
  const students = rows.filter(s => {
    if (seenStudent.has(s.id)) return false;
    seenStudent.add(s.id);
    return true;
  });

  // Get parents from parents table (richer than legacy parent_email field) — names + which
  // student they belong to, so each parent can be grouped under their child. A parent with
  // no Schoology email is still listed: PowerSchool or the teacher may give an address (#173).
  const parents = db.prepare(`
    SELECT DISTINCT p.id, p.student_id, p.first_name, p.last_name, p.email, p.extra_email
    FROM parents p
    JOIN enrolments e ON e.student_id = p.student_id
    WHERE e.course_id IN (${placeholders}) AND e.dropped_at IS NULL
    ORDER BY p.last_name, p.first_name
  `).all(...courseIds);

  const parentsExist = parents.length > 0;

  // #66: with PowerSchool alerts on, only guardians PowerSchool says are contactable are
  // copied (not do-not-contact, deceased, unmatched or unchecked), and the legacy
  // parent_email, which has no guardian to check, is not copied at all. This runs before
  // the address de-duplication so a left-out guardian cannot take the place of a kept one.
  // #173: a copied guardian's address is the PowerSchool slot's email when there is one
  // (contact.ps), else the Schoology email, followed by the teacher's extra email; every
  // address of a left-out guardian is withheld.
  const wantStudent = type === 'student' || type === 'both';
  const wantParent = type === 'parent' || type === 'both';
  const checkContacts = getFeatures().powerschool_alerts;
  const withheld = []; // per guardian left out, its addresses, counted after de-duplication
  const addressesOf = (p, ps) => [ps?.email || p.email, p.extra_email].filter(Boolean);
  const parentsByStudent = new Map();
  if (wantParent) {
    const contacts = checkContacts ? contactsForStudents(db, students.map(s => s.id)) : null;
    for (const p of parents) {
      if (!parentsByStudent.has(p.student_id)) parentsByStudent.set(p.student_id, []);
      const contact = contacts?.get(p.student_id)?.byParent.get(p.id);
      if (!contacts || contact?.status === 'contactable') {
        parentsByStudent.get(p.student_id).push({ ...p, addresses: addressesOf(p, contact?.ps) });
      } else {
        withheld.push([p.email, contact?.ps?.email, p.extra_email].filter(Boolean));
      }
    }
  }

  const fullName = (first, last) => [first, last].filter(Boolean).join(' ').trim();
  // Match the rest of the app: teacher override > Schoology preferred > first name
  const studentName = (s) => fullName(preferredFirstName(s), s.last_name);

  // Walk students in roster order. For "both" this naturally places each student's
  // parents immediately after the student; for "parent" it groups parents by child.
  const entries = [];
  for (const s of students) {
    const sName = studentName(s);
    if (wantStudent && s.email) {
      entries.push({ email: s.email, name: sName });
    }
    if (wantParent) {
      if (checkContacts ? parentsByStudent.has(s.id) : parentsExist) {
        for (const p of parentsByStudent.get(s.id) || []) {
          const name = `${fullName(p.first_name, p.last_name)} (parent of ${sName})`;
          for (const email of p.addresses) entries.push({ email, name });
        }
      } else if (s.parent_email && checkContacts) {
        // A student with no parent rows, in any class: the legacy address has no guardian to check.
        withheld.push([s.parent_email]);
      } else if (s.parent_email) {
        // Legacy fallback: no parent name on file, but we still know whose parent it is
        entries.push({ email: s.parent_email, name: `Parent of ${sName}` });
      }
    }
  }

  // Dedup by address (case-insensitive) across the selected courses, keeping the first
  // occurrence (e.g. a parent of two enrolled siblings is listed once, under the first).
  const seenEmail = new Set();
  const deduped = entries.filter(e => {
    const key = e.email.toLowerCase();
    if (seenEmail.has(key)) return false;
    seenEmail.add(key);
    return true;
  });

  // Guardians left out, by address: one that is also copied through another child is
  // not counted. Both sets use one key (trimmed, any case: emailKey). A guardian's own
  // addresses (Schoology, PowerSchool, extra) count once together, as do rows that share
  // an address (one guardian of two children): the addresses not copied are joined into
  // groups (union-find), and each group is one guardian.
  const copied = new Set(deduped.map(e => emailKey(e.email)));
  const group = new Map();
  const find = (k) => { while (group.get(k) !== k) k = group.get(k); return k; };
  for (const addresses of withheld) {
    const keys = addresses.map(emailKey).filter(k => k && !copied.has(k));
    for (const k of keys) if (!group.has(k)) group.set(k, k);
    for (const k of keys.slice(1)) group.set(find(k), find(keys[0]));
  }
  const excluded = new Set([...group.keys()].map(find)).size;

  // "Name <email>". Quote the display name when it contains characters that have
  // meaning in an address list — commas, and the parens used by the "parent of" tag.
  const emails = deduped.map(e => {
    const display = /[(),<>@;:"\[\]]/.test(e.name) ? `"${e.name.replace(/"/g, '')}"` : e.name;
    return `${display} <${e.email}>`;
  });

  // Outlook-friendly: semicolon-separated
  res.json({
    students,
    emails,
    formatted: emails.join('; '),
    // Bare addresses, same order + dedup, for the "emails only" format
    addresses: deduped.map(e => e.email),
    count: emails.length,
    excluded,
  });
});

// GET /api/tools/random/:courseId?count=1 — random name picker
// :courseId is a comma-separated list of course IDs.
router.get('/random/:courseId', (req, res) => {
  const db = getDb();
  const count = Math.max(1, parseInt(req.query.count) || 1);
  const [courseIds, placeholders] = parseCourseIds(req.params.courseId);

  // DISTINCT dedups students enrolled in more than one selected course
  const students = db.prepare(`
    SELECT DISTINCT s.id, s.first_name, s.last_name, s.preferred_name, s.preferred_name_teacher
    FROM students s
    JOIN enrolments e ON e.student_id = s.id
    WHERE e.course_id IN (${placeholders}) AND e.dropped_at IS NULL
  `).all(...courseIds);

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
// :courseId is a comma-separated list of course IDs.
router.get('/groups/:courseId', (req, res) => {
  const db = getDb();
  const groupCount = Math.max(2, parseInt(req.query.count) || 4);
  const balanced = req.query.balanced === 'true';
  const [courseIds, placeholders] = parseCourseIds(req.params.courseId);

  // DISTINCT dedups students enrolled in more than one selected course.
  // Balance uses standards-based mastery proficiency, NOT raw assignment scores:
  // the simple (unweighted) average of a student's category-level rollups
  // (is_category = 1) across the selected course(s). Overrides are ignored — we
  // use the synced grade_percentage. avg_pct is NULL when a student has no
  // proficiency data yet, and those students are placed randomly below.
  let students = db.prepare(`
    SELECT DISTINCT s.id, s.first_name, s.last_name, s.preferred_name, s.preferred_name_teacher,
           (SELECT ROUND(AVG(mr.grade_percentage), 1)
            FROM mastery_rollups mr
            WHERE mr.student_uid = s.schoology_uid
              AND mr.course_id IN (${placeholders})
              AND mr.is_category = 1
              AND mr.grade_percentage IS NOT NULL) AS avg_pct
    FROM students s
    JOIN enrolments e ON e.student_id = s.id
    WHERE e.course_id IN (${placeholders}) AND e.dropped_at IS NULL
  `).all(...courseIds, ...courseIds);

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
// client/src/lib/nameFormats.js) so switching format needs no round trip.
router.get('/roster/:courseId', (req, res) => {
  const db = getDb();
  const [courseIds, placeholders] = parseCourseIds(req.params.courseId);

  // DISTINCT dedups students enrolled in more than one selected course.
  const students = db.prepare(`
    SELECT DISTINCT s.id, s.first_name, s.last_name, s.preferred_name, s.preferred_name_teacher
    FROM students s
    JOIN enrolments e ON e.student_id = s.id
    WHERE e.course_id IN (${placeholders}) AND e.dropped_at IS NULL
    ORDER BY s.last_name, s.first_name
  `).all(...courseIds);

  res.json({ students, count: students.length });
});

export default router;
