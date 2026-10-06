import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CourseSection } from './StudentPage.jsx';

vi.mock('../components/MasteryPerformanceSummary.jsx', () => ({ default: () => null }));

function renderCourseSection(flagsByAssignment, gradeOverrides = {}) {
  return render(
    <MemoryRouter>
      <CourseSection
        course={{ id: 1, course_name: 'AIML' }}
        grades={[{
          course_id: 1,
          assignment_id: 10,
          schoology_assignment_id: 'sa-10',
          assignment_title: 'Computer Vision Project',
          due_date: '2026-04-12',
          score: 80,
          assignment_max_points: 100,
          exception: 0,
          late: 0,
          draft: 0,
          submitted_at: 1,
          grading_scale_id: null,
          mastery: null,
          ...gradeOverrides,
        }]}
        flagsByAssignment={flagsByAssignment}
        studentUid="uid-1"
        scales={[]}
      />
    </MemoryRouter>
  );
}

describe('CourseSection review flag badge', () => {
  it('renders a review_needed flag as an amber "⚑ Review:" badge on the assignment row', () => {
    renderCourseSection({
      10: [{ id: 5, flag_type: 'review_needed', flag_reason: 'Check citations', assignment_id: 10, resolved: 0 }],
    });
    const badge = screen.getByText(/⚑ Review: Check citations/);
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass('badge', 'badge-amber');
  });

  it('renders no review badge when the assignment has no flags', () => {
    renderCourseSection({});
    expect(screen.queryByText(/⚑ Review:/)).not.toBeInTheDocument();
  });

  it('renders a re-submit requested pill for a resubmit_requested flag', () => {
    renderCourseSection({
      10: [{ id: 7, flag_type: 'resubmit_requested', assignment_id: 10, resolved: 0 }],
    });
    const pill = screen.getByText(/⟳ Re-submit requested/);
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveClass('badge', 'badge-resubmit');
  });

  it('renders a Resubmitted pill when the grade row has resubmitted=true', () => {
    renderCourseSection({}, { resubmitted: true });
    const pill = screen.getByText(/↩ Resubmitted/);
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveClass('badge', 'badge-resubmitted');
  });

  it('renders no Resubmitted pill when resubmitted is absent', () => {
    renderCourseSection({});
    expect(screen.queryByText(/↩ Resubmitted/)).not.toBeInTheDocument();
  });
});

describe('CourseSection assignment title link', () => {
  it('links an unaligned (e.g. Completion-scale) assignment to its /assessment/ page, like the gradebook does', () => {
    renderCourseSection({}, { grading_scale_id: '7165818', score: 100, mastery: null });
    expect(screen.getByRole('link', { name: 'Computer Vision Project' })).toHaveAttribute('href', '/course/1/assessment/sa-10');
  });

  it('still links an aligned assignment', () => {
    renderCourseSection({}, { mastery: { topics: [{ topic_id: 't1', title: 'Topic 1', grade: 'EX' }] } });
    expect(screen.getByRole('link', { name: 'Computer Vision Project' })).toHaveAttribute('href', '/course/1/assessment/sa-10');
  });
});

describe('CourseSection submission timeline', () => {
  const timeline = {
    due: { date: '2026-10-06', time: '15:00' }, extension: null, deadline: '2026-10-06',
    submission: { state: 'submitted', firstAt: Math.floor(new Date('2026-10-12T09:00:00').getTime() / 1000), latestAt: null, late: true, day: 4, lateMinutes: null, schoologyLate: true },
    overdue: null, resubmission: null, referral: null, limit: 8,
  };

  it('shows when the work came in and how late, in place of the raw due date', () => {
    renderCourseSection({}, { timeline });
    const row = screen.getByTestId('submission-timeline');
    expect(row).toHaveTextContent('Due Tue 06/10 15:00');
    expect(row).toHaveTextContent('Submitted Mon 12/10 09:00 · day 4, late');
    expect(screen.queryByText(/^Due: /)).not.toBeInTheDocument();
  });

  it('one "?" in the table header explains the day numbers', () => {
    renderCourseSection({}, { timeline });
    expect(screen.getAllByRole('img', { name: /Day 1 is the due date/ })).toHaveLength(1);
  });

  it('without a timeline the plain due date stays', () => {
    renderCourseSection({});
    expect(screen.getByText('Due: 2026-04-12')).toBeInTheDocument();
  });
});
