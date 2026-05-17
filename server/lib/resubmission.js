// Resubmission detection (#49, Part B). A row counts as "resubmitted since last
// graded" when the latest non-draft submission revision is newer than the grade
// timestamp. Guards: a grade must exist, and the grade time must be known.
export function isResubmitted(grade) {
  if (!grade) return false;
  const submittedAt = Number(grade.submitted_at) || 0;
  const latestRevisionAt = Number(grade.latest_revision_at) || 0;
  if (submittedAt <= 0 || latestRevisionAt <= 0) return false;
  // score is null for an ungraded row; exception is an integer enum (>0 = set).
  const hasGrade = grade.score != null || (Number(grade.exception) || 0) > 0;
  if (!hasGrade) return false;
  return latestRevisionAt > submittedAt;
}
