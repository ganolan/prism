import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import SubmissionStatusPill from './SubmissionStatusPill.jsx';

const LTI = { is_lti_submission: 1, due_date: '2026-06-01', lti_fetch_status: 'ok' };

const stu = (over = {}) => ({
  exception: 0, late: 0, draft: 0, submitted_at: 0,
  submission_type: null, lti_submission_state: null, ...over,
});

describe('SubmissionStatusPill', () => {
  it('shows "Submitted" for a submitted LTI student', () => {
    render(<SubmissionStatusPill student={stu({ lti_submission_state: 'submitted' })} assignment={LTI} />);
    expect(screen.getByText('Submitted')).toBeInTheDocument();
  });
  it('shows "In Progress"', () => {
    render(<SubmissionStatusPill student={stu({ lti_submission_state: 'in_progress' })} assignment={LTI} />);
    expect(screen.getByText('In Progress')).toBeInTheDocument();
  });
  it('renders nothing when status is unknown and fetch was ok', () => {
    const { container } = render(<SubmissionStatusPill student={stu()} assignment={LTI} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('shows an unavailable affordance when the LTI fetch failed', () => {
    render(<SubmissionStatusPill student={stu()} assignment={{ ...LTI, lti_fetch_status: 'failed' }} />);
    expect(screen.getByText(/unavailable/i)).toBeInTheDocument();
  });
});
