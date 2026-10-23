import { Router } from 'express';
import { getDb } from '../db/index.js';
import { getGradingScalesMap } from '../db/scales.js';
import { arrivedKeys } from '../services/resubmissions.js';
import { timelineContext } from '../services/submissionTimeline.js';
import { getAssignmentFilesMany } from '../services/oneDriveLinks.js';
import { getRoster } from '../services/assessmentContext.js';
import { matchFilesToRoster } from '../lib/oneDriveSubmissions.js';
import { getFeatures } from '../middleware/featureGate.js';
import { psAlertsForStudent } from '../services/psAlertStore.js';
import { contactsForStudents } from '../services/guardianContactStore.js';
import { readSupportSummary, SupportSummaryError } from '../services/psSupportSummary.js';
import { waitingCopies, flagLines } from '../services/savedGrades.js';
import { buildAssessmentView, courseFlags } from '../services/assessmentView.js';
import { getAttachmentForAssignment } from '../services/rubricAttach.js';
import { getUnfinishedGrading } from '../services/unfinishedGrading.js';

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

// GET /api/students/:id — student profile with courses, grades, notes, and flags (open resubmission requests)
// GET /api/students/:id/support-summary → { rows: [{ category, description, url? }], readAt }:
// the PowerSchool Student Support Summary, read on demand when the teacher opens
// "Show alerts" (#163; server/services/psSupportSummary.js). For the teacher only.
const SUPPORT_SUMMARY_STATUS = {
  NO_ALERT: 404, NOT_FOUND: 404, NOT_LINKED: 404, NO_COURSE: 409, NOT_ON_ROSTER: 409,
  SESSION_EXPIRED: 503, SECURITY_VIOLATION: 502, PS_FAILED: 502,
};
router.get('/:id/support-summary', async (req, res) => {
  if (!getFeatures().powerschool_alerts) return res.status(404).json({ error: 'PowerSchool alerts are off' });
  try {
    res.json(await readSupportSummary(getDb(), Number(req.params.id)));
  } catch (err) {
    if (err instanceof SupportSummaryError) return res.status(SUPPORT_SUMMARY_STATUS[err.code] || 502).json({ error: err.message, code: err.code });
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', (req, res) => {
  const db = getDb();
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if (!student) return res.status(404).json({ error: 'Student not found' });

  const courses = db.prepare(`
    SELECT c.*, e.id as enrolment_id
    FROM courses c
    JOIN enrolments e ON e.course_id = c.id
    WHERE e.student_id = ? AND e.dropped_at IS NULL
    ORDER BY c.course_name
  `).all(req.params.id);

  // LEFT JOIN grades so untouched assignments still appear (with null score).
  // hasGradeRow lets the client distinguish "no engagement" (no row) from
  // "row exists but no score yet" — relevant for OneDrive missing detection.
  const grades = db.prepare(`
    SELECT
      g.id, g.score, g.max_score, g.grade_comment, g.comment_status,
      g.exception, g.late, g.draft, g.submitted_at, g.latest_revision_at, g.submission_type, g.lti_submission_state,
      g.first_submitted_at, g.test_attempt,
      a.id as assignment_id, a.accepts_submissions, a.is_test,
      a.title as assignment_title, a.due_date, a.is_lti_submission, a.max_points as assignment_max_points,
      a.grading_scale_id, a.display_weight, a.schoology_assignment_id,
      c.course_name, c.id as course_id,
      CASE WHEN g.id IS NOT NULL THEN 1 ELSE 0 END as has_grade_row
    FROM enrolments e
    JOIN courses c ON c.id = e.course_id
    JOIN assignments a ON a.course_id = c.id AND a.published = 1 AND a.removed_at IS NULL
    LEFT JOIN grades g ON g.student_id = e.student_id AND g.assignment_id = a.id
    LEFT JOIN folders f ON f.schoology_folder_id = a.folder_id AND f.course_id = a.course_id
    LEFT JOIN folders fp ON fp.schoology_folder_id = f.parent_id AND fp.course_id = f.course_id AND f.parent_id != '0'
    WHERE e.student_id = ? AND e.dropped_at IS NULL
      AND (
        a.num_assignees IS NULL OR a.num_assignees = 0
        OR EXISTS (
          SELECT 1 FROM assignment_assignees aa
          WHERE aa.assignment_id = a.id AND aa.schoology_uid = ?
        )
      )
    ORDER BY
      c.course_name,
      CASE WHEN a.folder_id IS NULL OR a.folder_id = '0' THEN a.display_weight
           WHEN f.parent_id IS NOT NULL AND f.parent_id != '0' THEN COALESCE(fp.display_weight, 0)
           ELSE COALESCE(f.display_weight, a.display_weight) END ASC,
      CASE WHEN a.folder_id IS NULL OR a.folder_id = '0' THEN 0
           WHEN f.parent_id IS NOT NULL AND f.parent_id != '0' THEN COALESCE(f.display_weight, 0)
           ELSE a.display_weight END ASC,
      CASE WHEN f.parent_id IS NOT NULL AND f.parent_id != '0' THEN a.display_weight ELSE 0 END ASC,
      a.title
  `).all(req.params.id, student.schoology_uid || '');

  // The submission timeline per assignment (due, extension, submitted when and how
  // late, clock day if missing, referral): one context per course.
  const contexts = new Map();
  // A flagged task's popover (#40): the grade Prism saved before the flag removed it, in words,
  // and the flag's reason line.
  const copies = waitingCopies(db, { studentId: student.id });
  const lines = flagLines(db, { studentId: student.id });
  for (const g of grades) {
    g.saved_level = copies.get(`${student.id}:${g.assignment_id}`)?.summary ?? null;
    g.flag_line = lines.get(`${student.id}:${g.assignment_id}`) ?? null;
    if (!contexts.has(g.course_id)) contexts.set(g.course_id, timelineContext(db, { courseId: g.course_id }));
    const assignment = {
      id: g.assignment_id, due_date: g.due_date, is_lti_submission: g.is_lti_submission,
      accepts_submissions: g.accepts_submissions, is_test: g.is_test,
    };
    g.timeline = contexts.get(g.course_id).timeline(assignment, student.id, g.has_grade_row ? g : null);
  }

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

    // Arrived resubmissions (visible-feedback snapshots, Amendment B) — the ↩ badge.
    const arrived = arrivedKeys(db, { studentId: student.id });
    for (const g of grades) {
      const aid = String(g.schoology_assignment_id);
      const map = topicsByAssignment.get(aid);
      g.mastery = map ? { topics: [...map.values()].sort((a, b) => (a.external_id || '').localeCompare(b.external_id || '')) } : null;
      g.resubmitted = arrived.has(`${student.id}:${g.assignment_id}`);
    }
  }

  const notes = db.prepare(
    'SELECT * FROM notes WHERE student_id = ? ORDER BY created_at DESC'
  ).all(req.params.id);

  // Open resubmission requests (triage) read as 'resubmit_requested' badges. They are the only
  // flags the student page shows: Flag for review is gone (#40).
  const flags = db.prepare(`
    SELECT id, student_id, assignment_id, created_at FROM resubmissions
    WHERE student_id = ? AND kind = 'request' AND status = 'open'
  `).all(req.params.id).map((r) => ({ id: `resubmission-${r.id}`, student_id: r.student_id, assignment_id: r.assignment_id, flag_type: 'resubmit_requested', resolved: 0, created_at: r.created_at }));

  let parents = db.prepare(
    'SELECT * FROM parents WHERE student_id = ? ORDER BY last_name, first_name'
  ).all(req.params.id);

  // #66: each guardian's contact status from PowerSchool (may Prism copy the address?),
  // when the feature is on, with the PowerSchool slot's email and phone (contact.ps),
  // the address to show (contact.email) and the addresses the page may link and copy
  // (contact.copy), and the numbers it may make tel: links (contact.tel), both empty unless
  // contactable (#173). Off: parents are returned exactly as stored (the teacher's phone
  // and extra_email are columns, so they arrive either way).
  let guardiansSyncedAt;
  if (getFeatures().powerschool_alerts) {
    const contacts = contactsForStudents(db, [student.id]).get(student.id);
    parents = parents.map((p) => ({ ...p, contact: contacts.byParent.get(p.id) }));
    guardiansSyncedAt = contacts.guardiansSyncedAt;
  }

  // #117: PowerSchool alerts (labels + when last read), when the feature is on.
  const psAlerts = student && getFeatures().powerschool_alerts ? psAlertsForStudent(db, student.id) : null;

  res.json({
    ...student, courses, grades, notes, flags, parents, grading_scales: getGradingScalesMap(),
    ...(psAlerts ? { ps_alerts: psAlerts.alerts, ps_alerts_synced_at: psAlerts.synced_at } : {}),
    ...(guardiansSyncedAt !== undefined ? { guardians_synced_at: guardiansSyncedAt } : {}),
  });
});

// GET /api/students/:id/work-links?assignments=sa1,sa2
// This student's own OneDrive copy of each listed lti_submission assignment (#120,
// #135), for the student page: { links: { [aid]: { url, fileName, modifiedAt } | null },
// status: { [aid]: 'ok' | 'not_lti' | lookup status } }. Files are matched against
// the whole class (a name shared by two students matches neither), but only this
// student's link is returned: the page is shown to parents. The client asks for a
// few assignments at a time after the page renders; they share one SharePoint sign-in
// (plain HTTP, sharePointWeb.js, #141).
const MAX_WORK_LINK_IDS = 10;
router.get('/:id/work-links', async (req, res) => {
  const db = getDb();
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if (!student) return res.status(404).json({ error: 'Student not found' });
  const ids = [...new Set(String(req.query.assignments || '').split(',').map((s) => s.trim()).filter(Boolean))]
    .slice(0, MAX_WORK_LINK_IDS);
  const rows = ids.length ? db.prepare(`
    SELECT a.*, c.schoology_section_id FROM assignments a
    JOIN courses c ON c.id = a.course_id
    JOIN enrolments e ON e.course_id = c.id AND e.student_id = ? AND e.dropped_at IS NULL
    WHERE a.is_lti_submission = 1 AND a.schoology_assignment_id IN (${ids.map(() => '?').join(',')})
  `).all(student.id, ...ids) : [];

  const links = {};
  const status = Object.fromEntries(ids.map((id) => [id, 'not_lti']));
  if (rows.length && student.schoology_uid) {
    const results = await getAssignmentFilesMany(rows.map((r) => ({ sectionId: r.schoology_section_id, assignmentId: r.schoology_assignment_id })));
    for (const r of rows) {
      const aid = r.schoology_assignment_id;
      const result = results.get(`${r.schoology_section_id}:${aid}`) || { status: 'error' };
      status[aid] = result.status;
      links[aid] = result.status === 'ok'
        ? matchFilesToRoster(result.files, getRoster(db, r.course_id, r), result.origin)[student.schoology_uid] || null
        : null;
    }
  }
  res.json({ links, status });
});

// GET /api/students/:id/grade-cards?courseId=<local>[&assignmentId=<schoology>] (#176)
// -> { course: { id, archived, excluded, writable }, cards: { [schoologyAssignmentId]: {
//     assignment, topics, scoreScale, student, rubric, draft, hasDraft } } }
// The assessment page's grade card for this one student, for the student page and the gradebook
// pop-up: one card per task of the course the student is on (the tasks GET /api/students/:id lists),
// or just assignmentId's. Each card is buildAssessmentView narrowed to the student, so no other
// student's data is in it. rubric is the task's attached rubric ({ id, rubric, topicByCriterion }) or
// null; draft this student's stored Prism draft or null; hasDraft is true only while that draft is
// current (Schoology has not changed under it), as Triage's Unfinished grading counts it.
// The task set includes a dropped enrolment's course (unlike GET /api/students/:id, which lists current
// enrolments only), so the pop-up can open the card of a student who left. hasDraft is then false, and
// false in an archived or excluded course too, because getUnfinishedGrading does not scope them in;
// the stored draft is still returned. course.writable is false for those and for a linked-section set
// (#178): the client shows no Edit there.
router.get('/:id/grade-cards', (req, res) => {
  const db = getDb();
  const student = db.prepare('SELECT id, schoology_uid FROM students WHERE id = ?').get(req.params.id);
  if (!student) return res.status(404).json({ error: 'Student not found' });
  const courseId = Number(req.query.courseId);
  if (!Number.isInteger(courseId)) return res.status(400).json({ error: 'courseId is required' });
  const course = courseFlags(db, courseId);
  if (!course) return res.status(404).json({ error: 'Course not found' });

  const only = req.query.assignmentId ? String(req.query.assignmentId) : null;
  const tasks = db.prepare(`
    SELECT a.id, a.schoology_assignment_id
    FROM assignments a
    WHERE a.course_id = ? AND a.published = 1 AND a.removed_at IS NULL
      AND EXISTS (SELECT 1 FROM enrolments e WHERE e.student_id = ? AND e.course_id = a.course_id)
      AND (a.num_assignees IS NULL OR a.num_assignees = 0
           OR EXISTS (SELECT 1 FROM assignment_assignees aa WHERE aa.assignment_id = a.id AND aa.schoology_uid = ?))
      AND (? IS NULL OR a.schoology_assignment_id = ?)
    ORDER BY a.id
  `).all(courseId, student.id, student.schoology_uid || '', only, only);

  const drafts = new Map(db.prepare('SELECT assignment_id, draft_json FROM assessment_drafts WHERE student_id = ?')
    .all(student.id).map((d) => [d.assignment_id, d.draft_json]));
  const current = new Set(getUnfinishedGrading(db, { courseId, studentId: student.id })
    .filter((t) => t.students.some((s) => s.studentId === student.id && s.reasons.includes('draft')))
    .map((t) => String(t.schoologyAssignmentId)));

  const cards = {};
  for (const t of tasks) {
    const aid = String(t.schoology_assignment_id);
    const view = buildAssessmentView(db, { courseId, assignmentId: aid, studentId: student.id });
    let draft = null;
    try { draft = drafts.has(t.id) ? JSON.parse(drafts.get(t.id)) : null; } catch { draft = null; }
    cards[aid] = {
      assignment: view.assignment, topics: view.topics, scoreScale: view.scoreScale,
      student: view.students[0] ?? null,
      rubric: getAttachmentForAssignment(db, aid),
      draft, hasDraft: current.has(aid),
    };
  }
  res.json({ course, cards });
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

// PUT /api/students/:id/parents/:parentId — the teacher's additions to a parent (#173):
// body { phone?, extra_email? }. Only the keys sent are updated; '' or null clears one.
// An extra email must be one address: exactly one @ with text on both sides, and no
// whitespace, ';', ',', '<', '>', '?', '&' or '"'. → the updated row.
const EDITABLE_PARENT_FIELDS = ['phone', 'extra_email'];
const ONE_ADDRESS = /^[^\s@;,<>?&"]+@[^\s@;,<>?&"]+$/;
router.put('/:id/parents/:parentId', (req, res) => {
  const db = getDb();
  const body = req.body || {};
  const fields = EDITABLE_PARENT_FIELDS.filter((k) => Object.hasOwn(body, k));
  const values = fields.map((k) => (body[k] == null ? null : String(body[k]).trim() || null));
  const extra = values[fields.indexOf('extra_email')];
  if (extra && !ONE_ADDRESS.test(extra)) return res.status(400).json({ error: 'Extra email must be an email address' });
  const where = 'WHERE id = ? AND student_id = ?';
  const found = fields.length
    ? db.prepare(`UPDATE parents SET ${fields.map((k) => `${k} = ?`).join(', ')} ${where}`).run(...values, req.params.parentId, req.params.id).changes
    : db.prepare(`SELECT 1 FROM parents ${where}`).get(req.params.parentId, req.params.id);
  if (!found) return res.status(404).json({ error: 'Parent not found' });
  const updated = db.prepare('SELECT * FROM parents WHERE id = ?').get(req.params.parentId);
  res.json(updated);
});

export default router;
