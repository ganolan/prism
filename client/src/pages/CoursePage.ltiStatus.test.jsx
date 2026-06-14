// Gradebook grid: a failed OneDrive (lti_submission) document fetch surfaces as
// a per-cell "re-sync" warning, not the old misleading "Ungraded" dot (#76).
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { GradebookView } from './CoursePage.jsx';

const PAST = '2020-01-01 00:00:00';

function renderGrid(assignment, grades = {}) {
  const data = {
    assignments: [assignment],
    students: [{ id: 10, schoology_uid: 'u1', first_name: 'Ada', last_name: 'Lovelace' }],
    grades,
    grading_scales: {},
  };
  return render(
    <MemoryRouter>
      <GradebookView data={data} courseId="5" mastery={null} />
    </MemoryRouter>
  );
}

const lti = (over) => ({
  id: 1, title: 'OneDrive Essay', schoology_assignment_id: 'sa-1', aligned: 0,
  is_lti_submission: 1, due_date: PAST, ...over,
});

describe('GradebookView — lti submission-status unavailable marker (#76)', () => {
  it('shows a re-sync warning on an ungraded cell when the assignment fetch failed', () => {
    renderGrid(lti({ lti_fetch_status: 'failed' }));
    expect(screen.getByLabelText('Submission status unavailable')).toBeInTheDocument();
  });

  it('shows no warning when the fetch succeeded (ok)', () => {
    renderGrid(lti({ lti_fetch_status: 'ok' }));
    expect(screen.queryByLabelText('Submission status unavailable')).not.toBeInTheDocument();
  });

  it('shows no warning when the fetch was never attempted (null)', () => {
    renderGrid(lti({ lti_fetch_status: null }));
    expect(screen.queryByLabelText('Submission status unavailable')).not.toBeInTheDocument();
  });

  it('shows no warning on a graded cell even when the fetch failed', () => {
    renderGrid(lti({ lti_fetch_status: 'failed' }), { 10: { 1: { score: 12, exception: null } } });
    expect(screen.queryByLabelText('Submission status unavailable')).not.toBeInTheDocument();
  });

  it('no longer renders the misleading "Ungraded" dot for an unknown overdue cell', () => {
    renderGrid(lti({ lti_fetch_status: 'failed' }));
    expect(screen.queryByText('·')).not.toBeInTheDocument();
  });
});
