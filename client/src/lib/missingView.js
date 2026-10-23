// Work marked Missing shows IE on every topic or row, to inform talks with the student (#40). Shared by the
// grade card and the read-only feedback view until that is retired.
const MISSING_NO_LEVELS = 'Shown as IE because the work is marked Missing. Schoology holds no topic levels for this task yet.';
const MISSING_LEVELS = 'Marked Missing. These levels still count in the topic averages.';
// Feedback-row levels live only in Prism (Schoology never sees them), so their lines say that.
const MISSING_NO_ROWS = 'Shown as IE because the work is marked Missing. No rubric rows are scored for this task yet.';
const MISSING_ROWS = 'Marked Missing. These are the rubric rows Prism holds for this task.';

// Graham, 21 Oct 2026: work marked Missing shows IE on every topic or row, to inform talks with the
// student. Missing writes no levels and keeps those that exist (probed 21 and 22 Oct), so when none
// exist every level is shown as IE, and when some do they show as they are. Display only: nothing
// here is written, and the per-topic summaries keep Schoology's numbers. `grades` is the levels as
// Schoology holds them (topic id to level or null), or a feedback-row task's row levels as Prism
// holds them (`rows`: true); returns the levels to draw, or null when the flag is not Missing.
export function missingView(exception, grades, { rows = false } = {}) {
  if (Number(exception) !== 3) return null;
  const hasLevels = Object.values(grades).some(Boolean);
  const line = rows ? (hasLevels ? MISSING_ROWS : MISSING_NO_ROWS) : (hasLevels ? MISSING_LEVELS : MISSING_NO_LEVELS);
  return {
    hasLevels,
    grades: hasLevels ? grades : Object.fromEntries(Object.keys(grades).map((id) => [id, 'IE'])),
    line,
  };
}

