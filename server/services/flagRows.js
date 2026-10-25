// Triage's Flags panel (#174, docs/superpowers/specs/2026-10-23-triage-flags-panel-design.md): every
// Schoology flag that keeps a task out of a student's grade until the teacher acts. On this account
// Late, Incomplete and Absent leave the task out of the grade, so they always show; Missing counts as
// zero, so it shows only once the student has submitted after it; Exempt is a decision and never
// shows. A cleared flag whose saved grade (#40, excused_grades) is still waiting shows too.
// Flagged work keeps its rows in Make-ups, Overdue work and Feedback owed (Graham, 23 October 2026).
// Each row counts school days from the flag date (grades.flag_seen_at, day 1) and grows more urgent
// as the end of the semester that contains the task's due date approaches.

import { epochToLocalDate } from '../lib/schoolDays.js';
import { semesterEndFor } from '../lib/semesters.js';
import { isFlagCode, isExempt } from '../lib/flags.js';
import { fullName, ALIGNED_SQL, assignmentFacts, isSubmitted } from './triageCommon.js';
import { preferredFirstName } from './studentNames.js';

// The advice line per flag code, and for a saved grade not restored. Neutral by design: Absent's
// line names both usual next steps (Graham, 21 October 2026, on #174).
export const FLAG_ADVICE = {
  6: 'Grade the work, or mark it Missing if it is too late to count.',
  2: 'Set a date to finish, then grade it.',
  5: 'Arrange a make-up, or mark it Exempt if the absence is excused.',
  3: 'Clear the flag and grade the work.',
  saved_grade: 'Restore the saved grade, or publish a new one.',
};

const AMBER_DAYS = 10; // the last 10 school days of the semester
const RED_DAYS = 5; // the last 5, and after the end

// School days from `today` to `end`, both counted: green above 10, amber over the last 10, red over
// the last 5 and after the end (a row from an ended semester stays red). No end known → green.
export function flagTone(cal, today, end) {
  if (!end) return 'green';
  if (today > end) return 'red';
  const left = cal.between(today, end).days + 1;
  if (left <= RED_DAYS) return 'red';
  if (left <= AMBER_DAYS) return 'amber';
  return 'green';
}

// LTI submission times carry no seconds (Schoology's display string, .claude/schoology-api-reference.md),
// so one in the same minute as the flag may read up to 59 s early: count it as after the flag.
const LTI_MINUTE_SECS = 59;

// Did the student submit after the flag? A Schoology test stores no attempt time, so a test taken
// (test_attempt 'took') with no revision time counts as after, marked approx: the usual case is a
// Missing flag on a missed test and a make-up sat since (review, 23 Oct 2026).
function submittedAfterFlag(a, g) {
  if (!isSubmitted(a, g)) return { after: false, approx: false };
  const at = Number(g.latest_revision_at) || 0;
  if (!at) return { after: g.test_attempt === 'took', approx: g.test_attempt === 'took' };
  const slack = a.is_lti_submission ? LTI_MINUTE_SECS : 0;
  return { after: at + slack > (Number(g.flag_seen_at) || 0), approx: false };
}

// excused_grades.saved_at is SQLite datetime('now'): UTC 'YYYY-MM-DD HH:MM:SS' → a local date.
const savedOn = (savedAt) => epochToLocalDate(Date.parse(`${String(savedAt).replace(' ', 'T')}Z`) / 1000);

// Published tasks of the course, any due date (a flag can come before the due date).
function courseTasks(db, courseId) {
  return db.prepare(`
    SELECT a.id, a.course_id, a.schoology_assignment_id, a.title, a.due_date, a.is_lti_submission, a.num_assignees,
      ${ALIGNED_SQL} AS aligned
    FROM assignments a
    WHERE a.course_id = ? AND a.published = 1 AND a.removed_at IS NULL
  `).all(courseId);
}

// One course's rows. `ranges` from loadTermRanges; `studentId` limits to one student.
export function flagRows(db, { course, students, cal, today, formative, studentId = null, ranges }) {
  const courseFields = { courseId: course.id, courseName: course.course_name, blockNumber: course.block_number ?? null };
  const own = db.prepare('SELECT term_start AS start, term_end AS end FROM courses WHERE id = ?').get(course.id);
  const courseTerm = own?.start && own?.end ? own : null;
  const waitingCopy = db.prepare(`SELECT student_id, saved_at FROM excused_grades WHERE assignment_id = ? AND restored_at IS NULL`);
  const rows = [];
  for (const a of courseTasks(db, course.id)) {
    if (!a.aligned && !formative) continue;
    const facts = assignmentFacts(db, a);
    const copies = new Map(waitingCopy.all(a.id).map((c) => [c.student_id, c.saved_at]));
    const due = a.due_date ? a.due_date.slice(0, 10) : null;
    for (const st of students) {
      if (facts.assignees && !facts.assignees.has(st.schoology_uid)) continue;
      if (studentId != null && st.id !== Number(studentId)) continue;
      const g = facts.gradeByStudent.get(st.id);
      if (!g) continue;
      const code = Number(g.exception) || 0;
      let row = null;
      if (isFlagCode(code) && !isExempt(code)) {
        const flagSeenOn = epochToLocalDate(g.flag_seen_at);
        const after = submittedAfterFlag(a, g);
        if (flagSeenOn && (code !== 3 || after.after)) {
          row = { kind: 'flag', flag: code, flagSeenOn, submittedAfter: after.after, afterApprox: after.approx, advice: FLAG_ADVICE[code] };
        }
      } else if (code === 0 && copies.has(st.id)) {
        row = { kind: 'saved_grade', flag: 0, flagSeenOn: savedOn(copies.get(st.id)), submittedAfter: false, advice: FLAG_ADVICE.saved_grade };
      }
      if (!row || !row.flagSeenOn) continue;
      const { afterApprox = false, ...fields } = row;
      const semesterEnd = semesterEndFor(due ?? row.flagSeenOn, ranges, courseTerm);
      const { days, approx } = cal.between(row.flagSeenOn, today);
      const limit = semesterEnd ? Math.max(cal.between(row.flagSeenOn, semesterEnd).days + 1, 1) : days + 1;
      rows.push({
        ...fields,
        studentId: st.id, studentUid: st.schoology_uid, studentName: fullName(st), firstName: preferredFirstName(st),
        studentEmail: st.email ?? null, ...courseFields,
        assignmentId: a.id, schoologyAssignmentId: a.schoology_assignment_id, title: a.title, dueDate: due,
        aligned: !!a.aligned, score: g.score ?? null, exception: code,
        semesterEnd, day: days + 1, limit, tone: flagTone(cal, today, semesterEnd), approx: approx || afterApprox,
      });
    }
  }
  return rows;
}

const TONE_RANK = { red: 0, amber: 1, green: 2 };
// Red first, then the longest wait, then name.
export const compareFlagRows = (x, y) => TONE_RANK[x.tone] - TONE_RANK[y.tone]
  || y.day - x.day || x.studentName.localeCompare(y.studentName);
