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
