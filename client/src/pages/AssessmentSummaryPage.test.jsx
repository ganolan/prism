import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useState } from 'react';
import { StudentRubricCard } from './AssessmentSummaryPage.jsx';
import { createFlag, deleteFlag, writeMasteryScores, writeMasteryComment } from '../services/api.js';

vi.mock('../services/api.js', () => ({
  getMasteryForAssignment: vi.fn(),
  syncMasteryForAssignment: vi.fn(),
  writeMasteryScores: vi.fn().mockResolvedValue({}),
  writeMasteryComment: vi.fn().mockResolvedValue({}),
  createFlag: vi.fn().mockResolvedValue({ id: 99, flag_reason: 'Check citations' }),
  deleteFlag: vi.fn().mockResolvedValue({ success: true }),
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
  const { student, ...rest } = extraProps;
  return render(
    <MemoryRouter>
      <StudentRubricCard
        student={student || makeStudent()}
        topics={TOPICS}
        courseId="4"
        assignmentId="8"
        assignmentRow={{ id: 50, mastery_grading_period_id: 1, mastery_grading_category_id: 2 }}
        onSaved={() => {}}
        {...rest}
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
    // The real page unmounts every card while it reloads after a save (it
    // renders a global "Loading..." view). Reproduce that teardown here so
    // the test exercises the production path.
    function SaveHarness() {
      const [mounted, setMounted] = useState(true);
      if (!mounted) return null;
      return (
        <StudentRubricCard
          student={makeStudent()}
          topics={TOPICS}
          courseId="4"
          assignmentId="8"
          assignmentRow={{ mastery_grading_period_id: 1, mastery_grading_category_id: 2 }}
          onSaved={() => setMounted(false)}
        />
      );
    }
    render(
      <MemoryRouter>
        <SaveHarness />
      </MemoryRouter>
    );

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

  it('restores the display-to-student toggle after a remount', () => {
    const { unmount } = renderCard();

    const toggle = screen.getByRole('switch', { name: /display to student/i });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    unmount();
    renderCard();

    expect(
      screen.getByRole('switch', { name: /display to student/i })
    ).toHaveAttribute('aria-checked', 'true');
  });

  it('persists and restores a comment draft for a rubric-locked card', () => {
    const lockedStudent = { ...makeStudent(), exception: 3 };

    const { unmount } = renderCard({ student: lockedStudent });

    fireEvent.change(screen.getByPlaceholderText(/Teacher comment/i), {
      target: { value: 'locked but commented' },
    });
    expect(
      localStorage.getItem('prism:assessment-draft:4:8:enr-1')
    ).not.toBeNull();

    unmount();
    renderCard({ student: lockedStudent });

    expect(screen.getByPlaceholderText(/Teacher comment/i)).toHaveValue(
      'locked but commented'
    );
  });

  it('discards a stale draft when Schoology data changed (Schoology wins)', () => {
    const { unmount } = renderCard();

    fireEvent.click(screen.getByTitle('Set Topic 1 to Developing'));
    fireEvent.change(screen.getByPlaceholderText(/Teacher comment/i), {
      target: { value: 'my draft comment' },
    });
    expect(
      localStorage.getItem('prism:assessment-draft:4:8:enr-1')
    ).not.toBeNull();

    unmount();

    // Simulate Schoology holding newer data when the page next syncs.
    const updatedStudent = { ...makeStudent(), grade_comment: 'published in schoology' };
    renderCard({ student: updatedStudent });

    // Schoology wins: the synced comment shows, the stale draft is gone.
    expect(screen.getByPlaceholderText(/Teacher comment/i)).toHaveValue(
      'published in schoology'
    );
    expect(screen.queryByText('1 pending change')).not.toBeInTheDocument();
    expect(
      localStorage.getItem('prism:assessment-draft:4:8:enr-1')
    ).toBeNull();
  });

  it('discards a legacy draft that has no base signature', () => {
    // Drafts persisted before the staleness feature have no `base` key; they
    // must be treated as stale and discarded.
    localStorage.setItem(
      'prism:assessment-draft:4:8:enr-1',
      JSON.stringify({ pending: { t1: 'D' }, comment: 'legacy draft', display: true })
    );
    renderCard();
    expect(screen.queryByText('1 pending change')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Teacher comment/i)).toHaveValue('');
    expect(localStorage.getItem('prism:assessment-draft:4:8:enr-1')).toBeNull();
  });

  it('clears the stored draft when changes are discarded', () => {
    renderCard();

    fireEvent.click(screen.getByTitle('Set Topic 1 to Developing'));
    expect(
      localStorage.getItem('prism:assessment-draft:4:8:enr-1')
    ).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /discard changes/i }));

    expect(
      localStorage.getItem('prism:assessment-draft:4:8:enr-1')
    ).toBeNull();
  });
});

describe('StudentRubricCard review flag (#20)', () => {
  it('shows a "Flag for review" button when there is no review flag', () => {
    renderCard();
    expect(screen.getByRole('button', { name: /flag for review/i })).toBeInTheDocument();
  });

  it('creates a submission-scoped review_needed flag with a reason', async () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /flag for review/i }));
    fireEvent.change(screen.getByPlaceholderText('Reason for review...'), {
      target: { value: 'Check citations' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Flag' }));

    await waitFor(() => {
      expect(createFlag).toHaveBeenCalledWith({
        student_id: 1,
        assignment_id: 50,
        flag_type: 'review_needed',
        flag_reason: 'Check citations',
      });
    });
    expect(await screen.findByText(/Review: Check citations/)).toBeInTheDocument();
  });

  it('creates the flag when Enter is pressed in the reason input', async () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /flag for review/i }));
    const input = screen.getByPlaceholderText('Reason for review...');
    fireEvent.change(input, { target: { value: 'Check citations' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(createFlag).toHaveBeenCalledWith({
        student_id: 1,
        assignment_id: 50,
        flag_type: 'review_needed',
        flag_reason: 'Check citations',
      });
    });
    expect(await screen.findByText(/Review: Check citations/)).toBeInTheDocument();
  });

  it('does not create a flag when Enter is pressed with an empty reason', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /flag for review/i }));
    fireEvent.keyDown(screen.getByPlaceholderText('Reason for review...'), { key: 'Enter' });
    expect(createFlag).not.toHaveBeenCalled();
  });

  it('cancels the reason input when Escape is pressed', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /flag for review/i }));
    const input = screen.getByPlaceholderText('Reason for review...');
    fireEvent.change(input, { target: { value: 'oops' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByPlaceholderText('Reason for review...')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /flag for review/i })).toBeInTheDocument();
  });

  it('cancels the reason input via the Cancel button', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /flag for review/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByPlaceholderText('Reason for review...')).not.toBeInTheDocument();
    expect(createFlag).not.toHaveBeenCalled();
  });

  it('shows the review badge and a Clear control when a flag exists', () => {
    renderCard({ student: { ...makeStudent(), review_flag: { id: 7, flag_reason: 'Re-mark' } } });
    expect(screen.getByText(/Review: Re-mark/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear review flag' })).toBeInTheDocument();
  });

  it('clears the review flag via deleteFlag', async () => {
    renderCard({ student: { ...makeStudent(), review_flag: { id: 7, flag_reason: 'Re-mark' } } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear review flag' }));
    await waitFor(() => expect(deleteFlag).toHaveBeenCalledWith(7));
  });

  it('flagging for review does not trigger a Schoology write', async () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /flag for review/i }));
    fireEvent.change(screen.getByPlaceholderText('Reason for review...'), {
      target: { value: 'Check citations' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Flag' }));
    await waitFor(() => expect(createFlag).toHaveBeenCalled());
    expect(writeMasteryScores).not.toHaveBeenCalled();
    expect(writeMasteryComment).not.toHaveBeenCalled();
  });

  it('shows an error and keeps no flag when creation fails', async () => {
    createFlag.mockRejectedValueOnce(new Error('network down'));
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /flag for review/i }));
    fireEvent.change(screen.getByPlaceholderText('Reason for review...'), {
      target: { value: 'Check citations' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Flag' }));

    expect(await screen.findByText(/Flag failed: network down/)).toBeInTheDocument();
    expect(screen.queryByText(/Review: Check citations/)).not.toBeInTheDocument();
  });
});
