// Gradebook cell markers (layout A, 18/10/2026): the late clock top right, one comment
// spot bottom right (an outline bubble for the overall comment, else the thread bubble),
// and the hover box with the overall comment, its visibility and a thread line.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../services/api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getCourseCommentSummaries: vi.fn(),
}));

import { GradebookView } from './CoursePage.jsx';
import { getCourseCommentSummaries } from '../services/api.js';

function renderGrid(grade, summaries = {}, timelines = {}) {
  getCourseCommentSummaries.mockResolvedValue({ assignments: summaries });
  const data = {
    assignments: [{ id: 1, title: 'Essay', schoology_assignment_id: 'sa-1', aligned: 0, is_lti_submission: 0, due_date: '2026-10-06 15:00:00', max_points: 100 }],
    students: [{ id: 10, schoology_uid: 'u1', first_name: 'Ada', last_name: 'Lovelace' }],
    grades: { 10: { 1: { score: 80, exception: null, submission_type: 'drop', ...grade } } },
    timelines, grading_scales: {},
  };
  return render(<MemoryRouter><GradebookView data={data} courseId="5" mastery={null} /></MemoryRouter>);
}
const cell = () => document.querySelector('tbody td:nth-child(2)');

beforeEach(() => vi.clearAllMocks());

describe('gradebook cell comment markers', () => {
  it('an overall comment with no thread: an outline bubble; hover shows it with its visibility', async () => {
    renderGrid({ grade_comment: 'Strong testing section.', comment_status: 1 });
    await waitFor(() => expect(getCourseCommentSummaries).toHaveBeenCalled());
    expect(screen.getByRole('img', { name: 'Has an overall comment' })).toHaveClass('overall-comment-mark');
    fireEvent.mouseEnter(cell());
    expect(screen.getByText('Your overall comment')).toBeInTheDocument();
    expect(screen.getByText('Visible to student')).toBeInTheDocument();
    expect(screen.getByText('Strong testing section.')).toBeInTheDocument();
  });

  it('a thread takes the corner (the outline bubble goes); hover adds the thread line, with unread', async () => {
    renderGrid({ grade_comment: '', comment_status: null }, { 'sa-1': { 10: { count: 2, student_text: true, unread: 1, read_at: 'x' } } });
    const bubble = await screen.findByRole('button', { name: /Open the thread/ });
    expect(bubble).toHaveClass('comment-dot--corner', 'comment-dot--unread');
    expect(screen.queryByRole('img', { name: 'Has an overall comment' })).toBeNull();
    fireEvent.mouseEnter(cell());
    expect(screen.getByText('No overall comment yet.')).toBeInTheDocument();
    expect(screen.getByText('Ada wrote in the submission comments (1 unread): click the bubble to open')).toBeInTheDocument();
  });

  it('nothing to say: no marker and no hover box', async () => {
    renderGrid({ grade_comment: '' });
    await waitFor(() => expect(getCourseCommentSummaries).toHaveBeenCalled());
    fireEvent.mouseEnter(cell());
    expect(screen.queryByText('Your overall comment')).toBeNull();
    expect(document.querySelector('.overall-comment-mark, .comment-dot')).toBeNull();
  });
});

const lateTimeline = {
  due: { date: '2026-10-06', time: '15:00' }, extension: null, deadline: '2026-10-06',
  submission: { state: 'submitted', firstAt: Math.floor(new Date('2026-10-12T09:00:00').getTime() / 1000), latestAt: null, late: true, day: 4, lateMinutes: null, schoologyLate: true, flagged: false },
  overdue: null, resubmission: null, referral: null, limit: 8,
};

describe('gradebook cell: the late clock is the submission only', () => {
  it('a late submission without a flag: the outline corner clock, with how late', () => {
    renderGrid({ score: 80, exception: null, late: 1 }, {}, { 10: { 1: lateTimeline } });
    const clock = document.querySelector('.late-clock');
    expect(clock).toHaveClass('late-clock--corner');
    expect(clock).not.toHaveClass('late-clock--flagged');
    expect(clock).toHaveAttribute('title', '3 school days late');
    expect(cell().querySelector('.flag-symbol')).toBeNull();
  });

  it('no late signal: no clock', () => {
    renderGrid({ score: 80, exception: null });
    expect(document.querySelector('.late-clock')).toBeNull();
  });

  it('exception 4 is invalid in Schoology: no symbol, no clock, the grade shows', () => {
    renderGrid({ score: 80, exception: 4 });
    expect(cell()).toHaveTextContent('80 / 100');
    expect(cell().querySelector('.flag-symbol')).toBeNull();
    expect(document.querySelector('.late-clock')).toBeNull();
  });
});

describe('gradebook cell: flag symbols', () => {
  it('the Late flag (6) shows the Late symbol where the grade was, and no level chip or grade text', () => {
    renderGrid({ score: null, exception: 6 });
    const sym = cell().querySelector('.flag-symbol');
    expect(sym).toHaveClass('flag-symbol--late');
    expect(sym).toHaveAttribute('aria-label', 'Late');
    expect(cell()).toHaveTextContent('LATE');
    expect(cell()).not.toHaveTextContent('100');
  });

  it('a Late flag on a late submission: one symbol plus the outline corner clock for the submission, never a filled clock', () => {
    renderGrid({ score: null, exception: 6, late: 1 }, {}, { 10: { 1: lateTimeline } });
    expect(cell().querySelectorAll('.flag-symbol')).toHaveLength(1);
    const clocks = cell().querySelectorAll('.late-clock');
    expect(clocks).toHaveLength(1);
    expect(clocks[0]).toHaveClass('late-clock--corner');
    expect(clocks[0]).not.toHaveClass('late-clock--flagged');
    expect(clocks[0]).toHaveAttribute('title', '3 school days late');
  });

  it.each([1, 6])('any flag (%i) with a late submission keeps the corner clock, even with no timeline', (exception) => {
    renderGrid({ score: null, exception, late: 1 });
    expect(cell().querySelector('.flag-symbol')).not.toBeNull();
    expect(cell().querySelectorAll('.late-clock')).toHaveLength(1);
  });

  it('a flag with an on-time submission has no clock', () => {
    renderGrid({ score: null, exception: 6, late: 0 });
    expect(cell().querySelector('.late-clock')).toBeNull();
  });

  it.each([[1, 'exempt', 'EXEMPT'], [2, 'incomplete', 'INCOMPLETE'], [3, 'missing', 'MISSING'], [5, 'absent', 'ABSENT'], [6, 'late', 'LATE']])(
    'flag %i shows flag-symbol--%s with its name under it, in a button that opens the pop-up, and no level chip',
    (exception, key, name) => {
      renderGrid({ score: null, exception });
      const sym = cell().querySelector('.flag-symbol');
      expect(sym).toHaveClass(`flag-symbol--${key}`);
      expect(sym).toHaveTextContent(name);
      expect(cell().querySelector('.exception-chip')).toBeNull();
      const button = sym.closest('button.cell-open');
      expect(button).not.toBeNull();
      fireEvent.click(button);
      expect(screen.getByRole('dialog', { name: 'Ada Lovelace: Essay' })).toBeInTheDocument();
    });
});

describe('gradebook cell: the Overdue letter (#40)', () => {
  it('past due with nothing submitted shows the letter O, titled Overdue (Missing is Schoology\'s flag)', () => {
    renderGrid({ score: null, exception: null, submission_type: null });
    const badge = cell().querySelector('.badge');
    expect(badge).toHaveTextContent(/^O$/);
    expect(badge).toHaveAttribute('title', 'Overdue');
    expect(cell().querySelectorAll('.badge')).toHaveLength(1);
    expect(badge).not.toHaveTextContent('M');
  });
  it('no grade row at all gives the same letter', () => {
    const data = {
      assignments: [{ id: 1, title: 'Essay', schoology_assignment_id: 'sa-1', aligned: 0, is_lti_submission: 0, due_date: '2026-10-06 15:00:00', max_points: 100 }],
      students: [{ id: 10, schoology_uid: 'u1', first_name: 'Ada', last_name: 'Lovelace' }],
      grades: {}, timelines: {}, grading_scales: {},
    };
    getCourseCommentSummaries.mockResolvedValue({ assignments: {} });
    render(<MemoryRouter><GradebookView data={data} courseId="5" mastery={null} /></MemoryRouter>);
    expect(cell().querySelector('.badge')).toHaveTextContent(/^O$/);
  });
});
