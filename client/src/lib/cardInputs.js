import { feedbackRowTopics, rowScores, rowTopicMapping } from './feedbackRows.js';

// Feedback rows (spec 2026-10-13): a rubric attached to a score-scale task. Its criteria become
// the card's topics ('row:<name>'), with each student's row levels as the scores, so the grid,
// drafts and suggestions work unchanged.
export function usesFeedbackRows(scoreScale, rubricData) {
  return Boolean(scoreScale && rubricData?.rubric);
}

// The three inputs a grade card takes from its assessment: topics, rubric and student, derived
// the same way wherever the card is shown (the assessment page, the student page, the gradebook).
// `rubricData` is { id, rubric, topicByCriterion } or null. A null `student` (the page asking
// for the shared topics and rubric alone) comes back null.
export function cardInputs({ topics, scoreScale, rubricData, student }) {
  const rowList = usesFeedbackRows(scoreScale, rubricData) ? feedbackRowTopics(rubricData.rubric.criteria) : null;
  return {
    topics: rowList ?? topics,
    rubric: rubricData
      ? { ...rubricData.rubric, topicByCriterion: rowList ? rowTopicMapping(rowList) : rubricData.topicByCriterion }
      : null,
    student: student && rowList ? { ...student, scores: rowScores(student.row_levels) } : student,
  };
}
