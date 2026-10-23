// Shared by the grade card's tests (the assessment page's and the card's own): a student, one
// topic, and renderCard, which mounts a StudentRubricCard in a router with those as defaults.
// Each test file mocks '../services/api.js' and the draft saver itself (vi.mock is per file).
import { createElement } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import StudentRubricCard from './StudentRubricCard.jsx';

export const TOPICS = [
  { id: 't1', title: 'Topic 1', category_title: 'Cat', external_id: 'X1' },
];

export function makeStudent() {
  return {
    id: 1,
    enrollment_id: 'enr-1',
    schoology_uid: 'uid-1',
    first_name: 'Ada',
    last_name: 'Lovelace',
    preferred_name: null,
    preferred_name_teacher: null,
    grade_comment: '',
    comment_status: 0,
    exception: null,
    scores: {},
  };
}

export function renderCard(extraProps = {}) {
  const { student, ...rest } = extraProps;
  return render(
    createElement(MemoryRouter, null,
      createElement(StudentRubricCard, {
        student: student || makeStudent(),
        topics: TOPICS,
        courseId: '4',
        assignmentId: '8',
        assignmentRow: { id: 50, mastery_grading_period_id: 1, mastery_grading_category_id: 2 },
        onSaved: () => {},
        ...rest,
      })));
}
