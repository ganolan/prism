import { Router } from 'express';
import { getDb } from '../db/index.js';
import { preferredFirstName } from '../services/studentNames.js';
import { getFeatures } from '../middleware/featureGate.js';
import { contactsForStudents } from '../services/guardianContactStore.js';
import { emailKey } from '../lib/guardianContacts.js';
import { loadClassRoster, parseRosterFilters, applyRosterFilters, rosterFacets } from '../services/classRoster.js';

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

const NAME_FIELDS = ['id', 'first_name', 'last_name', 'preferred_name', 'preferred_name_teacher'];
const pick = (s, fields) => Object.fromEntries(fields.map((f) => [f, s[f]]));

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
// Query params: type=student|parent|both (default: student), and the roster filters.
// Answers `excluded`: guardians left out because PowerSchool does not clear them (#66).
router.get('/emails/:courseId', (req, res) => {
  const db = getDb();
  const type = req.query.type || 'student';
  const [courseIds, placeholders] = parseCourseIds(req.params.courseId);

  // Each student once, even when enrolled in more than one of the selected courses
  const students = filteredRoster(db, req).map(s => pick(s, [...NAME_FIELDS, 'email', 'parent_email']));
  const keptStudents = new Set(students.map(s => s.id));

  // Get parents from parents table (richer than legacy parent_email field) — names + which
  // student they belong to, so each parent can be grouped under their child. A parent with
  // no Schoology email is still listed: PowerSchool or the teacher may give an address (#173).
  const parents = db.prepare(`
    SELECT DISTINCT p.id, p.student_id, p.schoology_uid, p.first_name, p.last_name, p.email, p.extra_email
    FROM parents p
    JOIN enrolments e ON e.student_id = p.student_id
    WHERE e.course_id IN (${placeholders}) AND e.dropped_at IS NULL
    ORDER BY p.last_name, p.first_name
  `).all(...courseIds).filter(p => keptStudents.has(p.student_id));

  const parentsExist = parents.length > 0;

  // #66: with PowerSchool alerts on, only guardians PowerSchool says are contactable are
  // copied (not do-not-contact, deceased, unmatched or unchecked), and the legacy
  // parent_email, which has no guardian to check, is not copied at all. This runs before
  // the address de-duplication so a left-out guardian cannot take the place of a kept one.
  // #173: a kept guardian contributes exactly contact.copy (guardianContactStore.js: the
  // PowerSchool or Schoology address and the teacher's extra email, without any address a
  // flagged guardian holds); every address of a left-out guardian is withheld. Off: the
  // Schoology email and the extra email.
  const fullName = (first, last) => [first, last].filter(Boolean).join(' ').trim();
  const wantStudent = type === 'student' || type === 'both';
  const wantParent = type === 'parent' || type === 'both';
  const checkContacts = getFeatures().powerschool_alerts;
  const withheld = []; // guardians left out: { uid, name, addresses }, counted after de-duplication
  const parentsByStudent = new Map();
  if (wantParent) {
    const contacts = checkContacts ? contactsForStudents(db, students.map(s => s.id)) : null;
    for (const p of parents) {
      const contact = contacts?.get(p.student_id)?.byParent.get(p.id);
      const all = [p.email, contact?.ps?.email, p.extra_email].filter((e) => emailKey(e));
      // A contactable guardian whose every address is blocked (a flagged guardian holds
      // it) is not copied either, and counts as the page counts it (StudentPage "not copied").
      if (!contacts || (contact?.status === 'contactable' && (contact.copy.length || !all.length))) {
        if (!parentsByStudent.has(p.student_id)) parentsByStudent.set(p.student_id, []);
        parentsByStudent.get(p.student_id).push({ ...p, addresses: contacts ? contact.copy : [p.email, p.extra_email].filter(Boolean) });
      } else {
        withheld.push({ uid: p.schoology_uid, name: fullName(p.first_name, p.last_name), addresses: all });
      }
    }
  }

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
      const kept = parentsByStudent.get(s.id) || [];
      for (const p of kept) {
        const name = `${fullName(p.first_name, p.last_name)} (parent of ${sName})`;
        for (const email of p.addresses) entries.push({ email, name });
      }
      if (!s.parent_email || (checkContacts ? kept.some(p => p.addresses.length) : parentsExist)) {
        // Nothing more: no legacy address, or the parent rows stand for it.
      } else if (checkContacts) {
        // No parent address copied for this student, in any class: the legacy address has
        // no guardian to check.
        withheld.push({ uid: null, name: '', addresses: [s.parent_email] });
      } else {
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

  // Guardians left out, counted once each. One guardian's rows (one per child) are joined
  // when they share a Schoology uid, or an address and the same name, so two people who
  // share a mailbox count twice. A legacy address (no name) joins the first guardian, or
  // else the first legacy address, it shares an address with: one only, so it cannot join
  // two guardians into one. A guardian counts when one of its addresses is not copied: one
  // also copied through another guardian is not counted. Addresses compare by emailKey.
  const copied = new Set(deduped.map(e => emailKey(e.email)));
  const nameKey = (name) => name.trim().replace(/\s+/g, ' ').toLowerCase();
  const shares = (a, b) => a.addresses.some(x => b.addresses.some(y => emailKey(x) === emailKey(y)));
  const root = withheld.map((_, i) => i);
  const find = (i) => { while (root[i] !== i) i = root[i]; return i; };
  const named = withheld.map((g, i) => i).filter(i => withheld[i].name);
  const legacy = withheld.map((g, i) => i).filter(i => !withheld[i].name);
  for (const i of named) {
    for (const j of named) {
      if (j >= i) break;
      const [a, b] = [withheld[i], withheld[j]];
      if ((a.uid && a.uid === b.uid) || (nameKey(a.name) === nameKey(b.name) && shares(a, b))) root[find(i)] = find(j);
    }
  }
  for (const i of legacy) {
    const j = [...named, ...legacy.filter(k => k < i)].find(k => shares(withheld[i], withheld[k]));
    if (j !== undefined) root[find(i)] = find(j);
  }
  const uncopied = new Set(withheld.flatMap((g, i) => (g.addresses.some(e => emailKey(e) && !copied.has(emailKey(e))) ? [find(i)] : [])));
  const excluded = uncopied.size;

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
