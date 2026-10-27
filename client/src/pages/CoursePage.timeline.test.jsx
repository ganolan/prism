// Gradebook grid: every cell shows the submission timeline in its instant hover overlay (#199: no
// native title), and graded late work keeps its corner clock (submissionStatus alone goes quiet once scored).
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { GradebookView } from './CoursePage.jsx';

const at = (s) => Math.floor(new Date(s.replace(' ', 'T') + ':00').getTime() / 1000);
const timeline = (submission, over = {}) => ({
  due: { date: '2026-10-06', time: '15:00' }, extension: null, deadline: '2026-10-06',
  submission: { state: 'submitted', firstAt: null, latestAt: null, late: null, day: null, lateMinutes: null, schoologyLate: null, ...submission },
  overdue: null, resubmission: null, referral: null, limit: 8, ...over,
});

function renderGrid({ grades = {}, timelines = {}, assignees = undefined }) {
  const data = {
    assignments: [{ id: 1, title: 'Essay', schoology_assignment_id: 'sa-1', aligned: 0, is_lti_submission: 1, due_date: '2026-10-06 15:00:00', max_points: 100, assignees }],
    students: [{ id: 10, schoology_uid: 'u1', first_name: 'Ada', last_name: 'Lovelace' }],
    grades, timelines, grading_scales: {},
  };
  return render(<MemoryRouter><GradebookView data={data} courseId="5" mastery={null} /></MemoryRouter>);
}

describe('GradebookView: submission timeline', () => {
  it('a graded, late cell keeps a corner clock (how late on hover) and explains itself on the cell', () => {
    const { container } = renderGrid({
      grades: { 10: { 1: { score: 80, exception: null, lti_submission_state: 'submitted', late: 1 } } },
      timelines: { 10: { 1: timeline({ firstAt: at('2026-10-12 09:00'), late: true, day: 4 }) } },
    });
    const clock = screen.getByRole('img', { name: '3 school days late' });
    expect(clock).toHaveClass('late-clock--corner');
    const cell = container.querySelector('td[aria-description*="Submitted 12/10 09:00"]');
    expect(cell).toContainElement(clock);
    expect(cell).not.toHaveAttribute('title');
    expect(cell.getAttribute('aria-description')).toBe('Due 06/10 15:00. Submitted 12/10 09:00 (3 school days late)');
    // The clock is passive in a cell: the cell's own overlay says how late, so one popover opens, not two.
    fireEvent.mouseEnter(clock);
    expect(document.querySelector('.help-pop')).toBeNull();
    fireEvent.mouseEnter(cell);
    expect([...document.querySelectorAll('.cell-hover__lines > div')].map((d) => d.textContent))
      .toEqual(['Due 06/10 15:00', 'Submitted 12/10 09:00 (3 school days late)']);
    expect(document.querySelector('.cell-hover')).not.toHaveTextContent('Your overall comment'); // no comment: no comment section
    fireEvent.mouseLeave(cell);
    expect(document.querySelector('.cell-hover')).toBeNull();
  });

  it('a graded on-time cell has no clock', () => {
    renderGrid({
      grades: { 10: { 1: { score: 80, exception: null, lti_submission_state: 'submitted', late: 0 } } },
      timelines: { 10: { 1: timeline({ firstAt: at('2026-10-06 14:00'), late: false }) } },
    });
    expect(document.querySelector('.late-clock')).toBeNull();
  });

  it('a student with no grade row still gets the missing-work clock on hover', () => {
    const { container } = renderGrid({
      timelines: { 10: { 1: timeline({ state: 'not_submitted' }, { overdue: { day: 9, overLimit: true } }) } },
    });
    const cell = container.querySelector('td[aria-description*="Not submitted (8 school days overdue, over the limit)"]');
    fireEvent.mouseEnter(cell);
    expect(document.querySelector('.cell-hover__lines')).toHaveTextContent('Not submitted (8 school days overdue, over the limit)');
  });
});

describe('GradebookView: hover text is an instant popover, never a native title (#199)', () => {
  it('a cell not assigned to the student says so in the popover, inside the cell', () => {
    const { container } = renderGrid({ assignees: [99] });
    const cell = screen.getByRole('cell', { name: 'Not assigned to this student' });
    expect(cell).toHaveTextContent(/^-$/);
    fireEvent.mouseEnter(cell);
    const pop = document.querySelector('.help-pop');
    expect(pop).toHaveTextContent('Not assigned to this student');
    expect(cell).toContainElement(pop); // a <span> beside a <td> is invalid in a <tr>
    expect(container.querySelector('[title]')).toBeNull();
  });

  it('a graded cell with an overall comment: its timeline lines, then the comment, in one overlay', () => {
    renderGrid({
      grades: { 10: { 1: { score: 80, exception: null, lti_submission_state: 'submitted', late: 0, grade_comment: 'Well argued.', comment_status: 1 } } },
      timelines: { 10: { 1: timeline({ firstAt: at('2026-10-06 14:00'), late: false }) } },
    });
    const cell = document.querySelector('td[aria-description]');
    fireEvent.mouseEnter(cell);
    const overlay = document.querySelector('.cell-hover');
    expect(overlay.querySelector('.cell-hover__lines')).toHaveTextContent('Submitted 06/10 14:00');
    expect(overlay).toHaveTextContent('Your overall comment');
    expect(overlay).toHaveTextContent('Well argued.');
    expect(document.querySelectorAll('.cell-hover, .help-pop')).toHaveLength(1);
  });
});
