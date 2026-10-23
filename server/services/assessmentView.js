// The assessment view of one task: its aligned topics, grade scale, and every student's scores,
// comment, flags, timeline and attention, as GET /api/mastery/:courseId/assignment/:assignmentId
// returns it (the assessment page's whole-class rubric view). With studentId it holds that one
// student only, which is how the student page and the gradebook pop-up show the same grade card
// (GET /api/students/:id/grade-cards, #176).
//
// Aligned topics, roster (honoring #54 targeting), scores, and grade-meta are shared with PrisMCP
// via server/services/assessmentContext.js. The topics query falls back to scored topics when
// alignments haven't synced yet.

import { getAlignedTopics, getRoster, getScoreMap, getGradeMetaRows, scoreScaleFor } from './assessmentContext.js';
import { getSchoologyConfig } from '../middleware/featureGate.js';
import { levelForScore } from '../lib/scoreScales.js';
import { toSchoologyWebUrl } from '../lib/schoologyWebUrl.js';
import { arrivedKeys, resubmissionByStudent } from './resubmissions.js';
import { savedGradeView } from './gradeFlags.js';
import { getFeedbackRows, getRowLevels } from './feedbackRows.js';
import { epochToLocalDate, todayLocal } from '../lib/schoolDays.js';
import { canUnsubmit } from './ltiUnsubmit.js';
import { timelineContext, lateWorkByStudent } from './submissionTimeline.js';
import { attentionByStudent } from './cardAttention.js';
import { isLinkedSet } from './courseSections.js';
import { getTriage } from './triage.js';

// When this course's / assignment's mastery was last read from Schoology (#52).
const courseSyncedAt = (db, courseId) => db.prepare('SELECT mastery_synced_at FROM courses WHERE id = ?').get(Number(courseId))?.mastery_synced_at ?? null;

// Prism may write this course's grades to Schoology only when it is current, not excluded, and not
// a set of linked sections (#178). The card is read-only otherwise.
const isWritable = (db, course) => !course.archived && !course.excluded && !isLinkedSet(db, course.id);

// → { id, archived, excluded, writable } for a course, or null for none.
export function courseFlags(db, courseId) {
  const c = db.prepare('SELECT id, archived, excluded FROM courses WHERE id = ?').get(courseId);
  return c && { ...c, writable: isWritable(db, c) };
}

// The roster, or with studentId that one student. A student the roster hides (dropped, or not
// targeted by an individually assigned task) still gets a card: the page they are viewing shows
// their grade whatever the enrolment says.
function rosterFor(db, courseId, assignmentRow, studentId) {
  const roster = getRoster(db, courseId, assignmentRow);
  if (studentId == null) return roster;
  const found = roster.find((s) => s.id === Number(studentId));
  if (found) return [found];
  return db.prepare(`
    SELECT s.id, s.schoology_uid, s.first_name, s.last_name, s.preferred_name, s.preferred_name_teacher,
           s.email, s.picture_url, e.schoology_enrolment_id AS enrollment_id
    FROM students s
    LEFT JOIN enrolments e ON e.student_id = s.id AND e.course_id = ?
    WHERE s.id = ?
    ORDER BY e.dropped_at IS NOT NULL, e.id DESC
    LIMIT 1
  `).all(courseId, Number(studentId));
}

// What every task of one course shares: the course's triage (late work + attention reasons) and its
// timeline context. Built once per request by a caller that builds many views of one course (the
// grade-cards route); without it each view builds its own, two whole-course triages per task.
export function courseViewContext(db, courseId) {
  return {
    triage: getTriage(db, { courseId: Number(courseId), includeFormative: true, today: todayLocal() }),
    timelines: timelineContext(db, { courseId }),
  };
}

// context: courseViewContext(db, courseId) for this course, or {} to build it here.
export function buildAssessmentView(db, { courseId, assignmentId, studentId = null }, context = {}) {
  const topics = getAlignedTopics(db, courseId, assignmentId);

  const assignmentRow = db.prepare(`
    SELECT * FROM assignments WHERE schoology_assignment_id = ? AND course_id = ?
  `).get(assignmentId, courseId);
  // Rewrite the captured app.schoology.com host onto the school web domain (#76).
  if (assignmentRow) {
    assignmentRow.web_url = toSchoologyWebUrl(assignmentRow.web_url, getSchoologyConfig().webBaseUrl);
  }

  // getRoster hides students an individually-targeted assignment isn't assigned
  // to (#54); an undefined assignmentRow (unknown id) is treated as open-to-all.
  const students = rosterFor(db, courseId, assignmentRow, studentId);
  const scoreMap = getScoreMap(db, assignmentId, topics.map(t => t.id));

  // Grade comments + exception + comment_status from the regular grades table.
  // Exception (1=Exempt, 2=Incomplete, 3=Missing, 5=Absent, 6=Late) removes any
  // existing score in Schoology when set — surfaced on the assessment page so
  // the rubric can be locked while an exception is active.
  // comment_status drives the Display-to-student toggle (#34): integer 1 = visible,
  // null/missing = hidden. has_grade_row distinguishes "synced and got null"
  // from "never synced" so the client can arm auto-flip only for virgin rows.
  const gradeRows = getGradeMetaRows(db, assignmentId);
  // Arrived resubmissions (visible-feedback snapshots, Amendment B) — the ⚠ pill.
  const arrived = assignmentRow ? arrivedKeys(db, { assignmentId: assignmentRow.id }) : new Set();
  const commentMap = {};
  const exceptionMap = {};
  const commentStatusMap = {};
  const hasGradeRowMap = {};
  const resubmittedMap = {};
  const ltiStateMap = {};
  const submissionTypeMap = {};
  const lateMap = {};
  const draftMap = {};
  const submittedAtMap = {};
  const scoreValueMap = {};
  const revisionAtMap = {};
  const gradeByUid = {};
  for (const c of gradeRows) {
    gradeByUid[c.schoology_uid] = c;
    scoreValueMap[c.schoology_uid] = c.score ?? null;
    commentMap[c.schoology_uid] = c.grade_comment || '';
    exceptionMap[c.schoology_uid] = c.exception ?? 0;
    commentStatusMap[c.schoology_uid] = c.comment_status ?? null;
    hasGradeRowMap[c.schoology_uid] = true;
    resubmittedMap[c.schoology_uid] = arrived.has(`${c.student_id}:${assignmentRow?.id}`);
    ltiStateMap[c.schoology_uid] = c.lti_submission_state ?? null;
    submissionTypeMap[c.schoology_uid] = c.submission_type ?? null;
    lateMap[c.schoology_uid] = c.late ?? 0;
    draftMap[c.schoology_uid] = c.draft ?? 0;
    submittedAtMap[c.schoology_uid] = c.submitted_at ?? 0;
    revisionAtMap[c.schoology_uid] = c.latest_revision_at ?? 0;
  }

  // Status lines (triage resubmissions, Amendment B) — the exact text Prism last
  // published in each student's comment, for the card's "resubmission received"
  // chip to find and replace (composeComment), keyed by local student id.
  const statusLineMap = {};
  if (assignmentRow) {
    for (const r of db.prepare('SELECT student_id, line, kind FROM status_lines WHERE assignment_id = ?').all(assignmentRow.id)) {
      statusLineMap[r.student_id] = { line: r.line, kind: r.kind };
    }
  }
  // The grade Prism saved before a flag removed it, while it waits to be restored (#40): the card
  // shows it grayed in the locked rubric and offers "Restore saved grade" once the flag is cleared.
  const savedCopies = new Map(assignmentRow
    ? db.prepare('SELECT * FROM excused_grades WHERE assignment_id = ? AND restored_at IS NULL').all(assignmentRow.id).map((r) => [r.student_id, r])
    : []);
  const savedGradeFor = (sid) => {
    if (!savedCopies.has(sid)) return null;
    try { return savedGradeView(db, assignmentRow.id, savedCopies.get(sid)); } catch { return null; }
  };

  // Triage resubmissions: open request (the card's pill) + derived state.
  const resubmissionMap = assignmentRow ? resubmissionByStudent(db, assignmentRow.id) : new Map();
  // The full submission picture per student (due, extension, submitted when / how
  // late, clock day if missing, resubmission, referral): the card's timeline row.
  const timelines = assignmentRow ? (context.timelines ?? timelineContext(db, { courseId: assignmentRow.course_id })) : null;
  // The Late work row per student (Refer / Waive on the card), as the dashboard shows it.
  const lateWork = assignmentRow
    ? lateWorkByStudent(db, { courseId: assignmentRow.course_id, assignmentId: assignmentRow.id, triage: context.triage })
    : new Map();
  // The page's calendar-based "Needs action" / "Watch" reasons + whether each student handed it in.
  const attention = attentionByStudent(db, { assignment: assignmentRow, students, triage: context.triage });

  // An unaligned assignment on a Schoology scale Prism can grade (#41) is one
  // plain gradebook grade: ship the scale (levels best → worst) and each
  // student's current level, read from the stored score by cutoff.
  const scoreScale = scoreScaleFor(assignmentRow, topics.length);
  // Feedback rows: only the levels of the attached rubric's rows. A level kept for a row
  // of an earlier rubric would make the card's draft baseline differ from its saved rows.
  const rowNames = new Set((getFeedbackRows(db, assignmentId, scoreScale)?.rows ?? []).map(r => r.criterion));
  const rowLevelsByUid = scoreScale ? Object.fromEntries(Object.entries(getRowLevels(db, assignmentId))
    .map(([uid, levels]) => [uid, Object.fromEntries(Object.entries(levels).filter(([name]) => rowNames.has(name)))])) : {};

  // Which class this is — the page names it (block + course) so sections of
  // the same course can't be confused.
  const course = db.prepare(
    'SELECT id, course_name, section_name, block_number, archived, excluded FROM courses WHERE id = ?'
  ).get(courseId) || null;

  return {
    course: course && { ...course, writable: isWritable(db, course) },
    assignment: assignmentRow || { schoology_assignment_id: assignmentId, title: 'Unknown Assignment' },
    topics,
    scoreScale,
    // #52: this assignment's own read (scores and comments), else the course's.
    masterySyncedAt: assignmentRow?.mastery_synced_at ?? courseSyncedAt(db, courseId),
    students: students.map(s => {
      const resubmission = resubmissionMap.get(s.id) || null;
      // Arrival date for the card's "resubmission received" chip: the snapshot's
      // own arrivedOn when known, else grades.latest_revision_at as a fallback —
      // only meaningful while the state is 'arrived'.
      const arrivedOn = resubmission?.state === 'arrived'
        ? (resubmission.arrivedOn || epochToLocalDate(revisionAtMap[s.schoology_uid]))
        : null;
      return {
        ...s,
        scores: scoreMap[s.schoology_uid] || {},
        grade_comment: commentMap[s.schoology_uid] || '',
        exception: exceptionMap[s.schoology_uid] || 0,
        comment_status: commentStatusMap[s.schoology_uid] ?? null,
        has_grade_row: hasGradeRowMap[s.schoology_uid] === true,
        resubmit_flag: resubmission?.request ? { id: resubmission.request.id } : null,
        resubmission,
        resubmitted: resubmittedMap[s.schoology_uid] === true,
        status_line: statusLineMap[s.id] || null,
        // The flag's reason line, for the flag symbol's popover (#40).
        flag_line: statusLineMap[s.id]?.kind === 'flag' ? statusLineMap[s.id].line : null,
        saved_grade: savedGradeFor(s.id),
        arrived_on: arrivedOn,
        lti_submission_state: ltiStateMap[s.schoology_uid] ?? null,
        // Phase 2: the Ask modal offers to unsubmit OneDrive work Prism last saw submitted.
        unsubmit_available: canUnsubmit({ isLti: assignmentRow?.is_lti_submission, ltiState: ltiStateMap[s.schoology_uid] }),
        submission_type: submissionTypeMap[s.schoology_uid] ?? null,
        late: lateMap[s.schoology_uid] ?? 0,
        draft: draftMap[s.schoology_uid] ?? 0,
        submitted_at: submittedAtMap[s.schoology_uid] ?? 0,
        score: scoreValueMap[s.schoology_uid] ?? null,
        scale_level: scoreScale ? levelForScore(scoreScale, scoreValueMap[s.schoology_uid]) : null,
        row_levels: rowLevelsByUid[s.schoology_uid] || {},
        timeline: timelines ? timelines.timeline(assignmentRow, s.id, gradeByUid[s.schoology_uid] || null, resubmission) : null,
        late_work: lateWork.get(s.id) || null,
        attention: attention.get(s.id) || { handedIn: false, reasons: [] },
      };
    }),
  };
}
