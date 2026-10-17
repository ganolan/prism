// Triage's Unfinished grading: unfinished work on a task that runs on no clock, so it never
// shows in the other panels. Per assignment in the current courses, the students with
//  - a Prism draft not yet published (a stored /assessment/ draft that is still live:
//    Schoology has not changed under it, the same check the card makes when it opens),
//  - feedback hidden (a teacher comment in Schoology the student cannot see),
//  - a review flag (Prism's own "Flag for review").
// The same three are Needs action reasons on the /assessment/ page
// (client/src/lib/assessmentFilters.js); a row links there with them selected.

import { teacherText } from '../lib/statusLines.js';
import { draftBaseline } from '../lib/assessmentDraft.js';
import { sqliteUtcToEpoch } from '../lib/resubmission.js';
import { epochToLocalDate } from '../lib/schoolDays.js';
import { currentCourses, ALIGNED_SQL, fullName } from './triageCommon.js';
import { getAlignedTopics, getRoster, getScoreMap, getGradeMetaRows, scoreScaleFor } from './assessmentContext.js';
import { getFeedbackRows, getRowLevels } from './feedbackRows.js';

export const UNFINISHED_GRADING_REASONS = ['draft', 'feedback_hidden', 'flagged'];

// The baseline signature the /assessment/ card computes for a student of this
// assignment (AssessmentSummaryPage's currentBaseline over the GET
// /api/mastery/:courseId/assignment/:id fields). A stored draft whose `base` differs
// is stale. → (student { schoology_uid }) → string.
export function cardBaselineFor(db, a) {
  const topics = getAlignedTopics(db, a.course_id, a.schoology_assignment_id);
  const scale = scoreScaleFor(a, topics.length);
  const scoreMap = getScoreMap(db, a.schoology_assignment_id, topics.map((t) => t.id));
  const meta = new Map(getGradeMetaRows(db, a.schoology_assignment_id).map((g) => [g.schoology_uid, g]));
  const rowNames = new Set((getFeedbackRows(db, a.schoology_assignment_id, scale)?.rows ?? []).map((r) => r.criterion));
  const rowLevels = scale ? getRowLevels(db, a.schoology_assignment_id) : {};
  return (st) => {
    const g = meta.get(st.schoology_uid) || {};
    const levels = Object.fromEntries(Object.entries(rowLevels[st.schoology_uid] || {}).filter(([name]) => rowNames.has(name)));
    const student = {
      scores: scoreMap[st.schoology_uid] || {},
      grade_comment: g.grade_comment || '',
      comment_status: g.comment_status ?? null,
      exception: g.exception || 0,
      score: g.score ?? null,
      row_levels: levels,
    };
    return draftBaseline(student, scale ? [] : topics, { includeScore: !!scale, rowLevels: scale ? student.row_levels : undefined });
  };
}

function parseDraft(json) {
  try { return JSON.parse(json); } catch { return null; }
}

// → [{ courseId, courseName, blockNumber, assignmentId, schoologyAssignmentId, title, aligned,
//      drafts, feedbackHidden, flagged, oldestDraftOn, students: [{ studentId, studentName, reasons }] }]
// Tasks with a draft come first (oldest draft first), then the most unfinished grading.
export function getUnfinishedGrading(db, { courseId = null, studentId = null } = {}) {
  const out = [];
  for (const c of currentCourses(db, courseId)) {
    const inCourse = 'a.course_id = ? AND a.published = 1 AND a.removed_at IS NULL';
    const drafts = db.prepare(`
      SELECT d.assignment_id, d.student_id, d.draft_json, d.updated_at
      FROM assessment_drafts d JOIN assignments a ON a.id = d.assignment_id WHERE ${inCourse}
    `).all(c.id);
    const hidden = db.prepare(`
      SELECT g.assignment_id, g.student_id, g.grade_comment, sl.line AS stored_line
      FROM grades g JOIN assignments a ON a.id = g.assignment_id
      LEFT JOIN status_lines sl ON sl.student_id = g.student_id AND sl.assignment_id = g.assignment_id
      WHERE ${inCourse} AND (g.comment_status IS NULL OR g.comment_status != 1)
        AND COALESCE(g.exception, 0) != 1 AND COALESCE(g.grade_comment, '') != ''
    `).all(c.id).filter((g) => teacherText(g.grade_comment, g.stored_line || null).length > 0);
    const flags = db.prepare(`
      SELECT DISTINCT f.assignment_id, f.student_id
      FROM flags f JOIN assignments a ON a.id = f.assignment_id
      WHERE ${inCourse} AND f.flag_type = 'review_needed' AND f.resolved = 0
    `).all(c.id);

    const byAssignment = new Map();
    const entry = (aid) => {
      if (!byAssignment.has(aid)) byAssignment.set(aid, { drafts: [], hidden: [], flags: [] });
      return byAssignment.get(aid);
    };
    for (const d of drafts) entry(d.assignment_id).drafts.push(d);
    for (const h of hidden) entry(h.assignment_id).hidden.push(h);
    for (const f of flags) entry(f.assignment_id).flags.push(f);

    for (const [aid, found] of byAssignment) {
      const a = db.prepare(`SELECT a.*, ${ALIGNED_SQL} AS aligned FROM assignments a WHERE a.id = ?`).get(aid);
      // Enrolled (and, for an individually assigned task, targeted) students only.
      const roster = new Map(getRoster(db, c.id, a).map((st) => [st.id, st]));
      const reasons = new Map(); // studentId → Set
      const add = (sid, reason) => {
        if (!roster.has(sid) || (studentId != null && sid !== Number(studentId))) return false;
        if (!reasons.has(sid)) reasons.set(sid, new Set());
        reasons.get(sid).add(reason);
        return true;
      };
      let oldestDraftOn = null;
      if (found.drafts.length) {
        const baseline = cardBaselineFor(db, a);
        for (const d of found.drafts) {
          const st = roster.get(d.student_id);
          const draft = parseDraft(d.draft_json);
          if (!st || !draft || draft.base !== baseline(st)) continue; // stale: the card discards it
          if (!add(d.student_id, 'draft')) continue;
          const on = epochToLocalDate(sqliteUtcToEpoch(d.updated_at));
          if (on && (!oldestDraftOn || on < oldestDraftOn)) oldestDraftOn = on;
        }
      }
      for (const h of found.hidden) add(h.student_id, 'feedback_hidden');
      for (const f of found.flags) add(f.student_id, 'flagged');
      if (reasons.size === 0) continue;

      const students = [...reasons].map(([sid, set]) => ({
        studentId: sid, studentName: fullName(roster.get(sid)),
        reasons: UNFINISHED_GRADING_REASONS.filter((r) => set.has(r)),
      })).sort((x, y) => x.studentName.localeCompare(y.studentName));
      const count = (r) => students.filter((s) => s.reasons.includes(r)).length;
      out.push({
        courseId: c.id, courseName: c.course_name, blockNumber: c.block_number ?? null,
        assignmentId: a.id, schoologyAssignmentId: a.schoology_assignment_id, title: a.title, aligned: !!a.aligned,
        drafts: count('draft'), feedbackHidden: count('feedback_hidden'), flagged: count('flagged'),
        oldestDraftOn, students,
      });
    }
  }
  const total = (r) => r.drafts + r.feedbackHidden + r.flagged;
  return out.sort((x, y) => (x.oldestDraftOn ? 0 : 1) - (y.oldestDraftOn ? 0 : 1)
    || (x.oldestDraftOn && y.oldestDraftOn ? x.oldestDraftOn.localeCompare(y.oldestDraftOn) : 0)
    || total(y) - total(x) || x.title.localeCompare(y.title));
}
