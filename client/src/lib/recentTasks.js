// The student page's Recent tasks (#185): the last tasks due in the student's current courses, newest
// due first, each with one status in the submission timeline's own words (lib/submissionTimeline.js),
// so the list reads the same as the grade cards under it.
//
// A Schoology flag stands for the status (`flag`, drawn as FlagSymbol): Missing, Exempt and the
// markers by name. Otherwise the timeline's submission part: "Submitted 27/10 21:14", "... (1 school
// day late)", "Not submitted (2 school days overdue)". With no submission tracked online Prism says
// only whether the task is graded, never that work is missing (the timeline's rule: no accusation on
// missing data).
//
// tone: 'ok' (handed in on time), 'late' (late, or overdue within the referral limit), 'over' (past
// the limit, or Missing), 'quiet' (nothing to act on).
import { FLAGS, isFlag } from './flags.js';
import { timelineParts } from './submissionTimeline.js';

const QUIET_STATES = new Set(['excused', 'in_progress', 'not_started', 'not_submitted']);

function status(g) {
  if (isFlag(g.exception)) {
    const code = Number(g.exception);
    return { flag: code, text: FLAGS[code].name, tone: code === 3 ? 'over' : code === 1 ? 'quiet' : 'late' };
  }
  const part = timelineParts(g.timeline, { showDue: false }).find((p) => p.key === 'submission');
  if (part) {
    const state = g.timeline.submission?.state;
    const tone = part.tone || (QUIET_STATES.has(state) ? 'quiet' : 'ok');
    return { flag: null, text: part.text, tone };
  }
  return { flag: null, text: g.score != null ? 'Graded' : 'Not graded yet', tone: 'quiet' };
}

// grades: GET /api/students/:id `grades`; courses: its `courses` (archived ones are left out);
// today: 'YYYY-MM-DD', local.
export function recentTasks(grades, courses, { today, limit = 6 } = {}) {
  const current = new Map((courses || []).filter((c) => !c.archived).map((c) => [c.id, c]));
  return (grades || [])
    .map((g) => ({ g, due: (g.due_date || '').slice(0, 10) }))
    .filter(({ g, due }) => current.has(g.course_id) && /^\d{4}-\d{2}-\d{2}$/.test(due) && due <= today)
    .sort((a, b) => (b.g.due_date || '').localeCompare(a.g.due_date || '') || a.g.assignment_title.localeCompare(b.g.assignment_title))
    .slice(0, limit)
    .map(({ g, due }) => ({
      key: `${g.course_id}-${g.assignment_id}`,
      title: g.assignment_title,
      courseId: g.course_id,
      courseName: current.get(g.course_id).course_name,
      schoologyAssignmentId: g.schoology_assignment_id,
      due,
      ...status(g),
    }));
}
