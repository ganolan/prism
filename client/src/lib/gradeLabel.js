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

// Derive submission-state badges for an assignment row.
// Independent from gradeLabel — the grade label shows "what was scored",
// while submission status shows "where is the student in the workflow"
// (missing, in progress, late, etc). Both can render together.
//
// Returns an array of { kind, label, tone } badges, in stable display order:
//   tone: 'red' | 'blue' | 'amber' | 'neutral'
//
// Status precedence:
//   - Teacher-set exceptions (Excused, Incomplete, Missing) take priority — those
//     are explicit teacher decisions.
//   - `late` (authoritative from /submissions endpoint) is shown when set.
//   - For ungraded past-due work with no exception: "Missing" badge, with a
//     secondary "Draft" qualifier when the student has in-progress work, or
//     "Not Started" when there is no submission revision (no grade row).
//   - For ungraded future-due work: "Draft" alone if in progress, otherwise no badge.
//
// `submitted_at` is Schoology's grade-row timestamp (Unix seconds). It flips
// from 0 to a real time when a submission/grade event occurs — empirically the
// only signal that distinguishes "submitted, awaiting grade" from "never
// opened" for OneDrive/GDrive lti_submission assignments where the
// /submissions endpoint returns an empty revision array in both cases.
//
// State table:
//   score != null                                → graded
//   submitted_at > 0 && score == null            → "Submitted" (awaiting grade)
//   draft = 1                                    → "In Progress"
//   submitted_at == 0 && !draft && past due      → "Missing • Not Started"
//   submitted_at == 0 && !draft && !past due     → no badge
export function submissionStatus({ score, exception, late, draft, submitted_at, due_date, today = new Date() }) {
  const exLabel = EXCEPTION_LABELS[exception];
  if (exception && exception !== 4 && exLabel) {
    const tone = exception === 1 ? 'blue' : 'red';
    return [{ kind: 'exception', label: exLabel, tone }];
  }
  const badges = [];
  if (late) badges.push({ kind: 'late', label: 'Late', tone: 'red' });

  const past = isPastDue(due_date, today);
  const ungraded = score == null;

  const submitted = Number(submitted_at) > 0;

  if (ungraded && submitted) {
    badges.push({ kind: 'submitted', label: 'Submitted', tone: 'blue' });
  } else if (ungraded && draft) {
    if (past) {
      badges.push({ kind: 'missing', label: 'Missing', tone: 'red' });
      badges.push({ kind: 'draft', label: 'Draft', tone: 'blue' });
    } else {
      badges.push({ kind: 'draft', label: 'Draft', tone: 'blue' });
    }
  } else if (ungraded && past && !late) {
    badges.push({ kind: 'missing', label: 'Missing', tone: 'red' });
    badges.push({ kind: 'not-started', label: 'Not Started', tone: 'amber' });
  }

  return badges;
}

function isPastDue(due_date, today) {
  if (!due_date) return false;
  // due_date may be 'YYYY-MM-DD HH:MM:SS' or ISO; Date parser handles both.
  const d = new Date(due_date);
  if (isNaN(d)) return false;
  return d < today;
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
