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

describe('gradebook cell: the late clocks', () => {
  const flagsTitle = 'Marked late with Flags';
  const lateTimeline = {
    due: { date: '2026-10-06', time: '15:00' }, extension: null, deadline: '2026-10-06',
    submission: { state: 'submitted', firstAt: Math.floor(new Date('2026-10-12T09:00:00').getTime() / 1000), latestAt: null, late: true, day: 4, lateMinutes: null, schoologyLate: true, flagged: true },
    overdue: null, resubmission: null, referral: null, limit: 8,
  };

  it('a graded cell with the Late flag keeps its grade and shows a flagged clock', () => {
    renderGrid({ score: 80, exception: 4 });
    expect(cell()).toHaveTextContent('80 / 100');
    expect(cell()).not.toHaveTextContent('Late');
    const clock = screen.getByRole('img', { name: flagsTitle });
    expect(clock).toHaveClass('late-clock--corner', 'late-clock--flagged');
    expect(clock).toHaveAttribute('title', flagsTitle);
  });

  it('a late submission and the flag: one flagged clock, both lines in its title', () => {
    renderGrid({ score: 80, exception: 4, late: 1 }, {}, { 10: { 1: lateTimeline } });
    const clocks = document.querySelectorAll('.late-clock');
    expect(clocks).toHaveLength(1);
    expect(clocks[0]).toHaveClass('late-clock--flagged');
    expect(clocks[0]).toHaveAttribute('title', `${flagsTitle}\n3 school days late`);
  });

  it('a late submission without the flag: the outline clock', () => {
    renderGrid({ score: 80, exception: null, late: 1 }, {}, { 10: { 1: { ...lateTimeline, submission: { ...lateTimeline.submission, flagged: false } } } });
    const clock = document.querySelector('.late-clock');
    expect(clock).not.toHaveClass('late-clock--flagged');
    expect(clock).toHaveAttribute('title', '3 school days late');
  });

  it('no late signal: no clock', () => {
    renderGrid({ score: 80, exception: null });
    expect(document.querySelector('.late-clock')).toBeNull();
  });
});

describe('gradebook cell: exception chips', () => {
  it.each([[1, 'Exc', 'excused'], [2, 'Inc', 'incomplete'], [3, 'Miss', 'missing']])(
    'exception %i shows the dashed chip in a button that opens the pop-up, and no level chip',
    (exception, text, tone) => {
      renderGrid({ score: null, exception });
      const chip = cell().querySelector('.exception-chip');
      expect(chip).toHaveTextContent(text);
      expect(chip).toHaveClass(`exception-chip--${tone}`);
      expect(cell()).not.toHaveTextContent(/Excused|Incomplete|Missing/);
      const button = chip.closest('button.cell-open');
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
