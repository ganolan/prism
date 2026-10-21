import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import AssignmentFeedback from './AssignmentFeedback.jsx';
import { getGradeFlags } from '../services/api.js';

vi.mock('../services/api.js', async (orig) => ({ ...(await orig()), getGradeFlags: vi.fn(), setGradeFlag: vi.fn() }));
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

  describe('Missing shows IE on every topic (#40)', () => {
    const NO_LEVELS = [{ ...TOPICS[0], grade: null }, { topic_id: 't2', title: 'Reflect', external_id: 'ART.6.1', category_title: 'HS Art: Responding', grade: null }];
    const NO_LEVEL_LINE = 'Shown as IE because the work is marked Missing. Schoology holds no topic levels for this task yet.';
    const LEVEL_LINE = 'Marked Missing. These levels still count in the topic averages.';
    // Feedback-row levels live only in Prism (#40 review I4): the lines say so.
    const ROW_NO_LEVEL_LINE = 'Shown as IE because the work is marked Missing. No rubric rows are scored for this task yet.';
    const ROW_LEVEL_LINE = 'Marked Missing. These are the rubric rows Prism holds for this task.';
    const ROWS = {
      mode: 'feedback_rows',
      rubric: { criteria: [
        { id: 'c1', position: 1, criterion_name: 'Playtesting', standard_title: 'Refine work', reporting_category: 'Producing',
          descriptors: { ED: 'Iterates from evidence.', EX: 'Tests and fixes.', D: 'Tests once.', EM: 'No testing.' } },
        { id: 'c2', position: 2, criterion_name: 'Polish', standard_title: 'Present work', reporting_category: 'Producing',
          descriptors: { ED: 'Seamless.', EX: 'Tidy.', D: 'Rough.', EM: 'Unfinished.' } },
      ] },
      topicByCriterion: [],
      rowLevels: {},
    };
    const missingSymbols = (root) => within(root).queryAllByRole('img', { name: 'Missing' });

    it('with no topic levels in Schoology, every topic of the descriptor grid shows IE with the Missing symbol', () => {
      const attachment = { ...ATTACHMENT, rubric: { criteria: [
        ATTACHMENT.rubric.criteria[0],
        { id: 'c2', position: 2, criterion_name: 'Reflection', descriptors: { ED: 'Deep.', EX: 'Clear.', D: 'Some.', EM: 'Thin.' } },
      ] }, topicByCriterion: [{ criterion_id: 'c1', topic_id: 't1' }, { criterion_id: 'c2', topic_id: 't2' }] };
      render(<AssignmentFeedback topics={NO_LEVELS} attachment={attachment} exception={3} />);
      const table = screen.getByRole('table');
      const awarded = table.querySelectorAll('td[data-awarded="true"]');
      expect(awarded).toHaveLength(2);
      awarded.forEach((td) => {
        expect(td.cellIndex).toBe(5); // topic column, then ED EX D EM IE
        expect(missingSymbols(td)).toHaveLength(1);
        expect(within(td).queryByText('MISSING')).toBeNull(); // no name beside the symbol
      });
      expect(screen.getByText(NO_LEVEL_LINE)).toBeInTheDocument();
      expect(screen.queryByText(/rubric hidden/)).not.toBeInTheDocument();
      expect(follows(screen.getByText(NO_LEVEL_LINE), table)).toBe(true);
    });

    it('with no topic levels, the compact grid shows IE on every topic too', () => {
      render(<AssignmentFeedback topics={NO_LEVELS} attachment={null} exception={3} />);
      const table = screen.getByRole('table');
      for (const title of ['Select, analyze', 'Reflect']) {
        const row = screen.getByText(title).closest('tr');
        const cells = within(row).getAllByRole('cell');
        expect(cells[5]).toHaveTextContent('IE');
        expect(missingSymbols(cells[5])).toHaveLength(1);
        expect(cells.slice(1, 5).every((c) => c.textContent === '')).toBe(true);
      }
      expect(missingSymbols(table)).toHaveLength(2);
      expect(screen.getByText(NO_LEVEL_LINE)).toBeInTheDocument();
    });

    it('with topic levels in Schoology, the real levels show as they are, under the other line', () => {
      render(<AssignmentFeedback topics={TOPICS} attachment={ATTACHMENT} exception={3} />);
      expect(screen.getByText(LEVEL_LINE)).toBeInTheDocument();
      expect(screen.queryByText(NO_LEVEL_LINE)).not.toBeInTheDocument();
      const table = screen.getByRole('table');
      expect(screen.getByText('Clear and usable.').closest('td')).toHaveAttribute('data-awarded', 'true');
      expect(table.querySelectorAll('td[data-awarded="true"]')).toHaveLength(1);
      expect(missingSymbols(table)).toHaveLength(0);
      expect(follows(screen.getByText(LEVEL_LINE), table)).toBe(true);
    });

    it('the compact grid keeps the real levels too', () => {
      render(<AssignmentFeedback topics={TOPICS} attachment={null} exception={3} />);
      const row = screen.getByText('Select, analyze').closest('tr');
      expect(within(row).getByText('EX')).toBeInTheDocument();
      expect(within(row).queryByText('IE')).toBeNull();
      expect(screen.getByText(LEVEL_LINE)).toBeInTheDocument();
    });

    it('the line carries the Missing symbol with its name', () => {
      render(<AssignmentFeedback topics={NO_LEVELS} attachment={null} exception={3} />);
      expect(screen.getByText('MISSING')).toBeInTheDocument();
    });

    it('on a feedback-row task with no row levels, every row shows IE', () => {
      render(<AssignmentFeedback attachment={ROWS} exception={3} score={{ text: 'Exhibiting', kind: 'scale' }} />);
      const table = screen.getByRole('table');
      const awarded = table.querySelectorAll('td[data-awarded="true"]');
      expect(awarded).toHaveLength(2);
      awarded.forEach((td) => expect(missingSymbols(td)).toHaveLength(1));
      expect(screen.getByText(ROW_NO_LEVEL_LINE)).toBeInTheDocument();
      expect(screen.queryByText(NO_LEVEL_LINE)).not.toBeInTheDocument();
      expect(follows(screen.getByText(ROW_NO_LEVEL_LINE), table)).toBe(true);
    });

    it('on a feedback-row task with row levels, they show as they are', () => {
      render(<AssignmentFeedback attachment={{ ...ROWS, rowLevels: { Playtesting: 'EX', Polish: 'D' } }} exception={3} />);
      expect(screen.getByText('Tests and fixes.').closest('td')).toHaveAttribute('data-awarded', 'true');
      expect(screen.getByText('Rough.').closest('td')).toHaveAttribute('data-awarded', 'true');
      expect(missingSymbols(screen.getByRole('table'))).toHaveLength(0);
      expect(screen.getByText(ROW_LEVEL_LINE)).toBeInTheDocument();
      expect(screen.queryByText(LEVEL_LINE)).not.toBeInTheDocument();
    });

    it('is a display transform: the topics it was given are not changed', () => {
      const topics = NO_LEVELS.map((t) => ({ ...t }));
      render(<AssignmentFeedback topics={topics} attachment={null} exception={3} />);
      expect(topics.map((t) => t.grade)).toEqual([null, null]);
    });

    it.each([0, 2, 5, 6])('exception %i shows no IE and neither line', (exception) => {
      render(<AssignmentFeedback topics={NO_LEVELS} attachment={null} exception={exception} />);
      expect(screen.queryByText(/Shown as IE/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Marked Missing/)).not.toBeInTheDocument();
      expect(screen.queryAllByRole('cell').filter((c) => c.textContent === 'IE')).toHaveLength(0);
    });

    it('Exempt still hides the rubric', () => {
      render(<AssignmentFeedback topics={NO_LEVELS} attachment={null} exception={1} />);
      expect(screen.getByText(/rubric hidden/)).toBeInTheDocument();
      expect(screen.queryByText(/Shown as IE/)).not.toBeInTheDocument();
    });
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

// #40: the Flags menu in the shared view's badge row (the gradebook pop-up and the student page).
describe('AssignmentFeedback: the Flags menu (#40)', () => {
  const FLAGS = { student: { id: 7, firstName: 'Ada' }, assignmentId: 30, exception: 0, score: 75, aligned: true, onChange: () => {} };

  it('flagsMenu puts a small Flags pill in the badge row, even with no other badge', () => {
    render(<AssignmentFeedback topics={TOPICS} flagsMenu={FLAGS} />);
    const pill = screen.getByRole('button', { name: /Flags/ });
    expect(pill).toHaveClass('flags-pill', 'flags-pill--sm');
    expect(pill.closest('.assignment-feedback__badges')).not.toBeNull();
  });

  it('the pill carries a set flag, so the status badges drop their flag badge', () => {
    const status = [{ kind: 'exception', label: 'Exempt', tone: 'green' }];
    const { unmount } = render(<AssignmentFeedback topics={TOPICS} status={status} flagsMenu={{ ...FLAGS, exception: 1 }} />);
    expect(screen.getByRole('button', { name: /Exempt/ })).toHaveClass('flags-pill--exempt');
    expect(document.querySelector('.assignment-feedback__badges .badge')).toBeNull();
    unmount();
    render(<AssignmentFeedback topics={TOPICS} status={status} />);
    expect(document.querySelector('.assignment-feedback__badges .badge')).toHaveTextContent('Exempt');
  });

  it('no flagsMenu: no pill', () => {
    render(<AssignmentFeedback topics={TOPICS} />);
    expect(screen.queryByRole('button', { name: /Flags/ })).toBeNull();
  });

  it('the panel opens inside the view, under the badge row', async () => {
    getGradeFlags.mockResolvedValue({ exception: 0, score: 75, graded: true, gradeText: '75 / 100', savedGrade: null, openRecords: [], hasDraft: false });
    render(<AssignmentFeedback topics={TOPICS} flagsMenu={FLAGS} comment="Nice." />);
    fireEvent.click(screen.getByRole('button', { name: /Flags/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Exempt/ }));
    const panel = await screen.findByRole('group', { name: 'Mark Ada exempt?' });
    await waitFor(() => expect(panel.closest('.assignment-feedback__panel')).not.toBeNull());
    expect(follows(panel, screen.getByText('Nice.'))).toBe(true);
  });
});
