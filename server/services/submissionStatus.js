// get_submission_status (issue #119): which students still have unsubmitted
// work, so a teacher can ask "who hasn't submitted X?" or pull an email list
// of everyone owing summative work. Reuses triage.js's verified submission
// rules (assignmentFacts/isSubmitted/studentState/tracksSubmissions) so this
// agrees with the dashboard and get_triage on what counts as "submitted".
import { todayLocal } from '../lib/schoolDays.js';
import { currentCourses, roster, ALIGNED_SQL, fullName } from './triageCommon.js';
import { assignmentFacts, studentState, tracksSubmissions } from './triage.js';

function assignmentsForCourse(db, courseId, assignmentId) {
  return db.prepare(`
    SELECT a.id, a.course_id, a.schoology_assignment_id, a.title, a.due_date, a.is_test, a.is_lti_submission,
           a.accepts_submissions, a.num_assignees, ${ALIGNED_SQL} AS aligned
    FROM assignments a
    WHERE a.course_id = ? AND a.published = 1 AND a.removed_at IS NULL AND (? IS NULL OR a.id = ?)
  `).all(courseId, assignmentId, assignmentId);
}

// Per (student, assignment) status. Returns null to mean "skip this item
// entirely" (the student sits a different copy of a test). First match wins.
function itemStatus(a, g, tracked) {
  if (Number(g.exception) === 1) return 'excused';
  if (a.is_test === 1) {
    if (g.test_attempt === 'took') return 'submitted';
    if (g.test_attempt === 'none') return 'not_started';
    if (g.test_attempt === 'not_assigned') return null;
    return 'unknown';
  }
  if (a.is_lti_submission) {
    if (g.lti_submission_state) return g.lti_submission_state; // submitted | in_progress | not_started
    if (g.submission_type) return 'submitted';
    return 'unknown';
  }
  if (tracked) return (g.submission_type || g.test_attempt === 'took') ? 'submitted' : 'not_started';
  return 'not_tracked'; // paper / gradebook-only: no submission channel
}

function kindOf(a) {
  if (a.is_test === 1) return 'test';
  if (a.is_lti_submission) return 'onedrive';
  if (a.accepts_submissions === 0) return 'paper';
  return 'dropbox';
}

const matchesStudentRef = (st, ref) =>
  String(st.id) === String(ref) || fullName(st).toLowerCase().includes(String(ref).toLowerCase());

export function getSubmissionStatus(db, {
  courseId = null, assignmentId = null, student = null, summativeOnly = false, pastDueOnly = false,
  status = 'not_submitted', today = todayLocal(),
} = {}) {
  if (status === 'all' && courseId == null && assignmentId == null && (student == null || student === '')) {
    throw new Error('status "all" needs a course, assignment_id or student (it lists every item); use status "not_submitted" for a whole-school view');
  }

  let effectiveCourseId = courseId;
  if (assignmentId != null) {
    const a = db.prepare(`
      SELECT a.course_id, c.archived, c.excluded FROM assignments a JOIN courses c ON c.id = a.course_id WHERE a.id = ?
    `).get(Number(assignmentId));
    if (!a) throw new Error(`No assignment with id ${assignmentId}`);
    if (a.archived || a.excluded) throw new Error(`Assignment ${assignmentId} is in a course that is archived or excluded from Prism`);
    effectiveCourseId = a.course_id;
  }
  const courses = currentCourses(db, effectiveCourseId);

  // studentId keyed map: a student in two courses appears once, with items from both.
  const byStudent = new Map();
  let unknown = 0;

  for (const c of courses) {
    const courseStudents = roster(db, c.id);
    const courseFields = { courseId: c.id, courseName: c.course_name, blockNumber: c.block_number ?? null };

    for (const a of assignmentsForCourse(db, c.id, assignmentId)) {
      if (summativeOnly && !a.aligned) continue;
      const due = a.due_date ? a.due_date.slice(0, 10) : null;
      const pastDue = due != null && due < today;
      if (pastDueOnly && !pastDue) continue;

      const facts = assignmentFacts(db, a);
      // Decided over the whole targeted roster, same as triage, so a
      // one-student view agrees with the whole-class one. Excused students are
      // excluded from that decision too (triage.js: `.filter(({ s }) => !s.excused)`
      // before tracksSubmissions) — an excused student's own submission_type must
      // not make an untracked (accepts_submissions NULL) assignment look tracked.
      const targeted = courseStudents.filter((st) => !facts.assignees || facts.assignees.has(st.schoology_uid));
      const states = targeted.map((st) => ({ st, s: studentState(a, facts, st) }));
      const tracked = tracksSubmissions(a, states.filter(({ s }) => !s.excused));

      for (const { st, s } of states) {
        if (student != null && student !== '' && !matchesStudentRef(st, student)) continue;
        const g = facts.gradeByStudent.get(st.id) || {};
        const itemKind = itemStatus(a, g, tracked);
        if (itemKind == null) continue; // not_assigned: sits the other copy
        if (itemKind === 'unknown') unknown++;
        const owing = (itemKind === 'not_started' || itemKind === 'in_progress') && !s.scored;
        const late = g.late === 1 ? true : g.late === 0 ? false : null;

        if (!byStudent.has(st.id)) {
          byStudent.set(st.id, { studentId: st.id, studentName: fullName(st), studentEmail: st.email ?? null, items: [] });
        }
        byStudent.get(st.id).items.push({
          assignmentId: a.id, schoologyAssignmentId: a.schoology_assignment_id, title: a.title,
          ...courseFields, dueDate: due, pastDue, summative: !!a.aligned, kind: kindOf(a),
          status: itemKind, owing, late, scored: s.scored, exception: g.exception != null ? Number(g.exception) : null,
        });
      }
    }
  }

  let students = [...byStudent.values()];
  if (status === 'not_submitted') {
    students = students
      .map((st) => ({ ...st, items: st.items.filter((i) => i.owing) }))
      .filter((st) => st.items.length > 0);
  }

  students.sort((x, y) => x.studentName.localeCompare(y.studentName));
  for (const st of students) {
    st.items.sort((x, y) => (x.dueDate ?? '9999-99-99').localeCompare(y.dueDate ?? '9999-99-99') || x.title.localeCompare(y.title));
  }

  const seenEmails = new Set();
  const emailList = [];
  let missingEmail = 0;
  for (const st of students) {
    if (st.studentEmail) {
      const key = st.studentEmail.toLowerCase();
      if (!seenEmails.has(key)) { seenEmails.add(key); emailList.push(st.studentEmail); }
    } else {
      missingEmail++;
    }
  }

  return {
    today,
    filters: { courseId, assignmentId, student, summativeOnly, pastDueOnly, status },
    students,
    emails: emailList.join('; '),
    counts: {
      students: students.length,
      items: students.reduce((n, st) => n + st.items.length, 0),
      missingEmail,
      unknown,
    },
    unknownHint: unknown > 0
      ? `${unknown} items have no submission data (OneDrive work or tests whose attempts were not read): run a full sync with the Schoology session connected, then ask again.`
      : null,
  };
}
