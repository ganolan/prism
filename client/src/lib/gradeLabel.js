// Resolve a grade to its display label given the assignment's grading scale.
// Returns { text, kind } where kind is one of:
//   'exception' — score overridden by Schoology exception flag (Excused/Missing/Incomplete/Late)
//   'pending'   — assignment not yet graded
//   'numeric'   — scale has no levels; render raw score / max
//   'scale'     — score matches a defined scale level (display the level name)
//   'mismatch'  — score does not match any level (suggests Schoology data error)
//
// Matches the user's rule: scores that don't fall on a defined scale level
// indicate a problem in Schoology and should surface visibly so the teacher
// can investigate and fix.

const EXCEPTION_LABELS = {
  1: 'Excused',
  2: 'Incomplete',
  3: 'Missing',
  4: 'Late',
};

// Derive submission-state badges for an assignment row. Returns an array of
// { kind, label, tone } badges; tone ∈ 'red' | 'blue' | 'amber' | 'green' |
// 'yellow' | 'neutral'. Graded cells return [] (gradeLabel shows the score).
//
// lti_submission work (#62): state comes from `lti_submission_state`
// ('submitted' | 'in_progress' | 'not_started'), read from the grader's
// per-assignment document endpoints — the only reliable signal. The public
// `draft`/`submitted_at` are auto-provisioned noise for lti and are ignored.
// Tones escalate by due-proximity (see the spec's matrix).
//
// Non-lti work: only submitted-or-not is knowable, so it consolidates to
// green "Submitted" or red "Missing" (overdue only); nothing before due.
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function dueProximity(due_date, today) {
  if (!due_date) return 'none';
  const d = new Date(due_date);
  if (isNaN(d)) return 'none';
  if (today > d) return 'overdue';
  if (today >= new Date(d.getTime() - WEEK_MS)) return 'soon';
  return 'early';
}

function ltiBadges(state, submission_type, due_date, today) {
  // GHD covered the cell but the document fetch didn't: trust "submitted".
  if (state == null && submission_type) state = 'submitted';
  const prox = dueProximity(due_date, today);
  if (state === 'submitted') return [{ kind: 'submitted', label: 'Submitted', tone: 'green' }];
  if (state === 'in_progress') {
    return [{ kind: 'in-progress', label: 'In Progress', tone: prox === 'overdue' ? 'yellow' : 'blue' }];
  }
  if (state === 'not_started') {
    const tone = (prox === 'soon' || prox === 'overdue') ? 'red' : 'neutral';
    return [{ kind: 'not-started', label: 'Not Started', tone }];
  }
  // null/unknown (no session): low-noise fallback — nothing before due.
  if (prox === 'overdue') return [{ kind: 'ungraded', label: 'Ungraded', tone: 'neutral' }];
  return [];
}

function nonLtiBadges({ submission_type, submitted_at, late, due_date, today }) {
  const badges = [];
  if (late) badges.push({ kind: 'late', label: 'Late', tone: 'red' });
  const submitted = !!submission_type || Number(submitted_at) > 0;
  if (submitted) {
    badges.push({ kind: 'submitted', label: 'Submitted', tone: 'green' });
  } else if (dueProximity(due_date, today) === 'overdue') {
    badges.push({ kind: 'missing', label: 'Missing', tone: 'red' });
  }
  return badges;
}

export function submissionStatus({ score, exception, late, draft, submitted_at, submission_type, is_lti_submission, lti_submission_state, due_date, today = new Date() }) {
  const exLabel = EXCEPTION_LABELS[exception];
  if (exception && exception !== 4 && exLabel) {
    const tone = exception === 1 ? 'blue' : 'red';
    return [{ kind: 'exception', label: exLabel, tone }];
  }
  if (score != null) return []; // graded — gradeLabel renders the score
  if (is_lti_submission) return ltiBadges(lti_submission_state, submission_type, due_date, today);
  return nonLtiBadges({ submission_type, submitted_at, late, due_date, today });
}

export function gradeLabel({ score, max_points, exception, grading_scale_id, scales }) {
  if (exception && EXCEPTION_LABELS[exception]) {
    return { text: EXCEPTION_LABELS[exception], kind: 'exception' };
  }
  if (score == null) {
    return { text: 'Pending', kind: 'pending' };
  }
  const scale = grading_scale_id != null ? scales?.[String(grading_scale_id)] : null;
  if (!scale || !scale.levels?.length) {
    const text = max_points ? `${score} / ${max_points}` : String(score);
    return { text, kind: 'numeric' };
  }
  const pct = max_points > 0 ? (score / max_points) * 100 : score;
  const match = scale.levels.find(l => Math.abs(l.average - pct) < 0.5);
  if (!match) {
    return { text: `?? ${score}`, kind: 'mismatch' };
  }
  return { text: match.name, kind: 'scale' };
}
