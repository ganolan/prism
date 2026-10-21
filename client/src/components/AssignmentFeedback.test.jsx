import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import AssignmentFeedback from './AssignmentFeedback.jsx';
import { gradeLabel } from '../lib/gradeLabel.js';

const TOPICS = [{ topic_id: 't1', title: 'Select, analyze', external_id: 'ART.5.1', category_title: 'HS Art: Producing', grade: 'EX' }];
const ATTACHMENT = {
  id: 1,
  rubric: { criteria: [{ id: 'c1', position: 1, criterion_name: 'UI/UX',
    descriptors: { ED: 'Polished and intuitive.', EX: 'Clear and usable.', D: 'Inconsistent.', EM: 'Hard to use.' } }] },
  topicByCriterion: [{ criterion_id: 'c1', topic_id: 't1' }],
};
const TIMELINE = {
  due: { date: '2026-10-06', time: '15:00' }, extension: null, deadline: '2026-10-06',
  submission: { state: 'submitted', firstAt: Math.floor(new Date('2026-10-06T09:00:00').getTime() / 1000), latestAt: null, late: false, day: 1, lateMinutes: null, schoologyLate: false },
  overdue: null, resubmission: null, referral: null, limit: 8,
};

const follows = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('AssignmentFeedback', () => {
  it('reads badges with the work links, then the timeline, the rubric and the comment', () => {
    render(
      <AssignmentFeedback
        status={[{ kind: 'submitted', label: 'Submitted', tone: 'green' }]}
        links={<a href="https://example.test/work">Open</a>}
        timeline={TIMELINE}
        topics={TOPICS}
        comment="Great use of evidence."
      />
    );
    const badge = screen.getByText('Submitted');
    const link = screen.getByRole('link', { name: 'Open' });
    const timeline = screen.getByTestId('submission-timeline');
    const rubric = screen.getByText('Select, analyze');
    const comment = screen.getByText('Great use of evidence.');
    // The work link shares the badges row (each status badge sits in a wrapper that
    // also holds its late clock).
    expect(link.parentElement).toBe(badge.closest('.status-pill-wrap').parentElement);
    expect(follows(link, timeline)).toBe(true);
    expect(follows(timeline, rubric)).toBe(true);
    expect(follows(rubric, comment)).toBe(true);
  });

  it('with an attached rubric shows the full descriptors and highlights the awarded level', () => {
    render(<AssignmentFeedback topics={TOPICS} attachment={ATTACHMENT} />);
    expect(screen.getByText('Polished and intuitive.')).toBeInTheDocument();
    const awarded = screen.getByText('Clear and usable.').closest('td');
    expect(awarded).toHaveAttribute('data-awarded', 'true');
    expect(screen.getByText('Polished and intuitive.').closest('td')).not.toHaveAttribute('data-awarded');
    // Read-only: nothing offers to set a level.
    expect(screen.queryByTitle(/^Set /)).not.toBeInTheDocument();
  });

  it('without an attached rubric falls back to the compact grid', () => {
    render(<AssignmentFeedback topics={TOPICS} attachment={null} />);
    const row = screen.getByText('Select, analyze').closest('tr');
    expect(within(row).getByText('EX')).toBeInTheDocument();
    expect(screen.queryByText('Clear and usable.')).not.toBeInTheDocument();
  });

  it('an attachment that maps none of the topics falls back to the compact grid', () => {
    render(<AssignmentFeedback topics={TOPICS} attachment={{ ...ATTACHMENT, topicByCriterion: [] }} />);
    expect(screen.queryByText('Clear and usable.')).not.toBeInTheDocument();
    expect(screen.getByText('Measurement Topic')).toBeInTheDocument();
  });

  it('a flag shows its symbol in the place of the score, with the saved grade in its popover', () => {
    render(<AssignmentFeedback score={gradeLabel({ score: 5, exception: 1 })} savedLevel="Exhibiting" />);
    expect(screen.getByText('Score:')).toBeInTheDocument();
    const sym = screen.getByRole('img', { name: 'Exempt' });
    expect(sym).toHaveClass('flag-symbol--exempt');
    expect(document.querySelector('.exception-chip')).toBeNull();
  });

  it('a points-only task shows its score in the rubric\'s place, with no rubric', () => {
    render(<AssignmentFeedback score={{ text: '50 / 100', kind: 'numeric' }} comment="Revise question 3." />);
    expect(screen.getByText('50 / 100')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(follows(screen.getByText('50 / 100'), screen.getByText('Revise question 3.'))).toBe(true);
  });

  it('hides the rubric while Exempt (a final flag) is set', () => {
    render(<AssignmentFeedback topics={TOPICS} attachment={ATTACHMENT} exception={1} />);
    expect(screen.getByText('Exempt')).toBeInTheDocument();
    expect(screen.getByText(/rubric hidden because Schoology removes the grade while it is flagged/)).toBeInTheDocument();
    expect(screen.queryByText('Clear and usable.')).not.toBeInTheDocument();
  });

  it.each([[2, 'Incomplete'], [5, 'Absent'], [6, 'Late']])('marker %i keeps the rubric, with its symbol and "Grading this work clears %s." (#40)', (exception, name) => {
    render(<AssignmentFeedback topics={TOPICS} attachment={ATTACHMENT} exception={exception} />);
    expect(screen.getByText('Clear and usable.')).toBeInTheDocument();
    expect(screen.getByRole('img', { name })).toBeInTheDocument();
    expect(screen.getByText(`Grading this work clears ${name}.`)).toBeInTheDocument();
    expect(screen.queryByText(/rubric hidden/)).not.toBeInTheDocument();
  });

  it('Missing says what Schoology really does: it counts the work as zero (it keeps the levels)', () => {
    render(<AssignmentFeedback topics={TOPICS} attachment={ATTACHMENT} exception={3} />);
    expect(screen.getByText('Missing')).toBeInTheDocument();
    expect(screen.getByText(/rubric hidden\. Schoology counts this as zero while it is flagged/)).toBeInTheDocument();
    expect(screen.queryByText(/removes the grade/)).not.toBeInTheDocument();
    expect(screen.queryByText('Clear and usable.')).not.toBeInTheDocument();
  });

  it('a feedback-row task shows its rows with the student\'s levels, then the overall level', () => {
    const rowsAttachment = {
      mode: 'feedback_rows',
      rubric: { criteria: [
        { id: 'c1', position: 1, criterion_name: 'Playtesting', standard_title: 'Refine work', reporting_category: 'Producing',
          descriptors: { ED: 'Iterates from evidence.', EX: 'Tests and fixes.', D: 'Tests once.', EM: 'No testing.' } },
      ] },
      topicByCriterion: [],
      rowLevels: { Playtesting: 'EX' },
    };
    render(<AssignmentFeedback attachment={rowsAttachment} score={{ text: 'Exhibiting', kind: 'scale' }} comment="Good loop." />);
    expect(screen.getByText('Criteria')).toBeInTheDocument();
    expect(screen.getByText('Tests and fixes.').closest('td')).toHaveAttribute('data-awarded', 'true');
    expect(screen.getByText('Iterates from evidence.').closest('td')).not.toHaveAttribute('data-awarded');
    const overall = screen.getByText('Overall:').parentElement;
    expect(within(overall).getByText('Exhibiting')).toBeInTheDocument();
    expect(follows(screen.getByText('Tests and fixes.'), overall)).toBe(true);
    expect(follows(overall, screen.getByText('Good loop.'))).toBe(true);
  });

  it('renders no empty badges row', () => {
    const { container } = render(<AssignmentFeedback topics={TOPICS} />);
    expect(container.querySelector('.assignment-feedback__badges')).toBeNull();
  });
});
