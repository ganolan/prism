import { feedbackRowTopics, rowScores, rowTopicMapping } from './feedbackRows.js';
import { studentReasons } from './assessmentFilters.js';

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

// The attention chips of a card fetched from GET /api/students/:id/grade-cards (the student page and
// the gradebook pop-up): the assessment page's reasons (studentReasons, with its filter context) for
// this one student. The raw topics and student, not cardInputs', as the assessment page passes them.
// `commentSummary` is this student's submission-comment summary for the task, or null.
export function cardReasons(card, commentSummary = null) {
  return studentReasons(card.student, {
    assignment: card.assignment,
    topics: card.topics,
    hasDraft: () => Boolean(card.hasDraft),
    commentSummaryOf: () => commentSummary,
  });
}
