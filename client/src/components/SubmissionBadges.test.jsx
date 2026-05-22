import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import SubmissionBadges from './SubmissionBadges.jsx';

describe('SubmissionBadges', () => {
  it('renders a status badge with the mapped tone class', () => {
    render(<SubmissionBadges status={[{ kind: 'missing', label: 'Missing', tone: 'red' }]} />);
    expect(screen.getByText('Missing')).toHaveClass('badge', 'badge-red');
  });

  it('maps the amber tone to badge-pink', () => {
    render(<SubmissionBadges status={[{ kind: 'not-started', label: 'Not Started', tone: 'amber' }]} />);
    expect(screen.getByText('Not Started')).toHaveClass('badge', 'badge-pink');
  });

  it('renders a review_needed flag as "⚑ Review: <reason>"', () => {
    render(
      <SubmissionBadges
        status={[]}
        flags={[{ id: 1, flag_type: 'review_needed', flag_reason: 'rescore Q3' }]}
      />
    );
    expect(screen.getByText(/⚑ Review: rescore Q3/)).toHaveClass('badge', 'badge-amber');
  });

  it('renders the resubmit_requested and resubmitted badges', () => {
    render(
      <SubmissionBadges
        status={[]}
        flags={[{ id: 'resubmit', flag_type: 'resubmit_requested' }]}
        resubmitted
      />
    );
    expect(screen.getByText(/⟳ Re-submit requested/)).toHaveClass('badge', 'badge-resubmit');
    expect(screen.getByText(/↩ Resubmitted/)).toHaveClass('badge', 'badge-resubmitted');
  });

  it('renders an unknown multi-word flag type with all underscores replaced', () => {
    render(
      <SubmissionBadges
        status={[]}
        flags={[{ id: 9, flag_type: 'manual_score_override', flag_reason: 'see notes', resolved: 0 }]}
      />
    );
    expect(screen.getByText('manual score override')).toHaveClass('badge', 'badge-red');
    expect(screen.getByText('see notes')).toBeInTheDocument();
  });

  it('suppresses a generic-flag reason that merely repeats the assignment title', () => {
    render(
      <SubmissionBadges
        status={[]}
        flags={[{ id: 9, flag_type: 'late_submission', flag_reason: 'Unit 3 Essay', resolved: 0 }]}
        assignmentTitle="Unit 3 Essay"
      />
    );
    expect(screen.getByText('late submission')).toBeInTheDocument();
    expect(screen.queryByText('Unit 3 Essay')).not.toBeInTheDocument();
  });

  it('renders nothing when there are no badges, flags, or resubmission', () => {
    const { container } = render(<SubmissionBadges status={[]} flags={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
