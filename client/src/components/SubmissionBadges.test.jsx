import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import SubmissionBadges from './SubmissionBadges.jsx';

describe('SubmissionBadges', () => {
  it('renders a status badge with the mapped tone class', () => {
    render(<SubmissionBadges status={[{ kind: 'overdue', label: 'Overdue', tone: 'red' }]} />);
    expect(screen.getByText('Overdue')).toHaveClass('badge', 'badge-red');
  });

  it('maps the amber tone to badge-amber (Incomplete, #40; it was pink while nothing used the tone)', () => {
    render(<SubmissionBadges status={[{ kind: 'exception', label: 'Incomplete', tone: 'amber' }]} />);
    expect(screen.getByText('Incomplete')).toHaveClass('badge', 'badge-amber');
  });

  it('maps the slate tone (Absent) to badge-slate', () => {
    render(<SubmissionBadges status={[{ kind: 'exception', label: 'Absent', tone: 'slate' }]} />);
    expect(screen.getByText('Absent')).toHaveClass('badge', 'badge-slate');
  });

  it('a late submission gets the outline clock; a Late-flag badge has no clock of its own', () => {
    const { rerender } = render(<SubmissionBadges status={[{ kind: 'submitted', label: 'Submitted', tone: 'green', late: true }]} lateTitle="2 school days late" />);
    expect(screen.getByRole('img', { name: '2 school days late' })).not.toHaveClass('late-clock--flagged');
    rerender(<SubmissionBadges status={[{ kind: 'exception', label: 'Late', tone: 'red' }]} />);
    expect(document.querySelector('.late-clock')).toBeNull();
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

  it('shows only the resubmit_requested flag; Flag for review is gone (#40)', () => {
    render(<SubmissionBadges status={[]} flags={[{ id: 1, flag_type: 'review_needed', flag_reason: 'rescore Q3' }]} />);
    expect(screen.queryByText(/Review/)).not.toBeInTheDocument();
    expect(screen.queryByText(/rescore Q3/)).not.toBeInTheDocument();
  });

  it('renders nothing when there are no badges, flags, or resubmission', () => {
    const { container } = render(<SubmissionBadges status={[]} flags={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
