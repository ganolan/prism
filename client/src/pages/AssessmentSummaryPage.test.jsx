import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { StudentRubricCard } from './AssessmentSummaryPage.jsx';

vi.mock('../services/api.js', () => ({
  getMasteryForAssignment: vi.fn(),
  syncMasteryForAssignment: vi.fn(),
  writeMasteryScores: vi.fn().mockResolvedValue({}),
  writeMasteryComment: vi.fn().mockResolvedValue({}),
}));

const TOPICS = [
  { id: 't1', title: 'Topic 1', category_title: 'Cat', external_id: 'X1' },
];

function makeStudent() {
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

function renderCard(extraProps = {}) {
  return render(
    <MemoryRouter>
      <StudentRubricCard
        student={makeStudent()}
        topics={TOPICS}
        courseId="4"
        assignmentId="8"
        assignmentRow={{ mastery_grading_period_id: 1, mastery_grading_category_id: 2 }}
        onSaved={() => {}}
        {...extraProps}
      />
    </MemoryRouter>
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe('StudentRubricCard draft persistence', () => {
  it('restores pending rubric selection and comment text after a remount', () => {
    const { unmount } = renderCard();

    fireEvent.click(screen.getByTitle('Set Topic 1 to Developing'));
    fireEvent.change(screen.getByPlaceholderText(/Teacher comment/i), {
      target: { value: 'work in progress' },
    });

    expect(screen.getByText('1 pending change')).toBeInTheDocument();

    unmount();
    renderCard();

    expect(screen.getByText('1 pending change')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Teacher comment/i)).toHaveValue(
      'work in progress'
    );
  });

  it('clears the stored draft after a successful save', async () => {
    renderCard();

    fireEvent.click(screen.getByTitle('Set Topic 1 to Developing'));
    expect(
      localStorage.getItem('prism:assessment-draft:4:8:enr-1')
    ).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Update Schoology' }));

    await waitFor(() => {
      expect(
        localStorage.getItem('prism:assessment-draft:4:8:enr-1')
      ).toBeNull();
    });
  });

  it('does not write a draft when there are no unsaved changes', () => {
    renderCard();
    expect(
      localStorage.getItem('prism:assessment-draft:4:8:enr-1')
    ).toBeNull();
  });
});
