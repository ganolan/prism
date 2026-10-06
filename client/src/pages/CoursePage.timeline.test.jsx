// Gradebook grid: every cell carries the submission timeline as hover text, and
// graded late work keeps its L (submissionStatus alone goes quiet once scored).
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { GradebookView } from './CoursePage.jsx';

const at = (s) => Math.floor(new Date(s.replace(' ', 'T') + ':00').getTime() / 1000);
const timeline = (submission, over = {}) => ({
  due: { date: '2026-10-06', time: '15:00' }, extension: null, deadline: '2026-10-06',
  submission: { state: 'submitted', firstAt: null, latestAt: null, late: null, day: null, lateMinutes: null, schoologyLate: null, ...submission },
  overdue: null, resubmission: null, referral: null, limit: 8, ...over,
});

function renderGrid({ grades = {}, timelines = {} }) {
  const data = {
    assignments: [{ id: 1, title: 'Essay', schoology_assignment_id: 'sa-1', aligned: 0, is_lti_submission: 1, due_date: '2026-10-06 15:00:00', max_points: 100 }],
    students: [{ id: 10, schoology_uid: 'u1', first_name: 'Ada', last_name: 'Lovelace' }],
    grades, timelines, grading_scales: {},
  };
  return render(<MemoryRouter><GradebookView data={data} courseId="5" mastery={null} /></MemoryRouter>);
}

describe('GradebookView: submission timeline', () => {
  it('a graded, late cell keeps an L and explains itself on hover', () => {
    const { container } = renderGrid({
      grades: { 10: { 1: { score: 80, exception: null, lti_submission_state: 'submitted', late: 1 } } },
      timelines: { 10: { 1: timeline({ firstAt: at('2026-10-12 09:00'), late: true, day: 4 }) } },
    });
    expect(screen.getByTitle('Late')).toHaveTextContent('L');
    const cell = container.querySelector('td[title*="Submitted Mon 12/10 09:00"]');
    expect(cell.getAttribute('title')).toBe('Due Tue 06/10 15:00\nSubmitted Mon 12/10 09:00 · day 4, late');
  });

  it('a graded on-time cell has no L', () => {
    renderGrid({
      grades: { 10: { 1: { score: 80, exception: null, lti_submission_state: 'submitted', late: 0 } } },
      timelines: { 10: { 1: timeline({ firstAt: at('2026-10-06 14:00'), late: false }) } },
    });
    expect(screen.queryByTitle('Late')).not.toBeInTheDocument();
  });

  it('a student with no grade row still gets the missing-work clock on hover', () => {
    const { container } = renderGrid({
      timelines: { 10: { 1: timeline({ state: 'not_submitted' }, { overdue: { day: 9, overLimit: true } }) } },
    });
    expect(container.querySelector('td[title*="Not submitted · day 9, past day 8"]')).not.toBeNull();
  });
});
