import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CourseSection } from './StudentPage.jsx';

vi.mock('../components/MasteryPerformanceSummary.jsx', () => ({ default: () => null }));

function renderCourseSection(flagsByAssignment, gradeOverrides = {}, sectionProps = {}) {
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
        {...sectionProps}
      />
    </MemoryRouter>
  );
}

describe('CourseSection resubmit badge', () => {
  it('renders no review badge: Flag for review is gone (#40)', () => {
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
    expect(row).toHaveTextContent('Due 06/10 15:00');
    expect(row).toHaveTextContent('Submitted 12/10 09:00 (3 school days late)');
    expect(screen.queryByText(/^Due: /)).not.toBeInTheDocument();
  });

  it('one "?" in the table header explains the counting', () => {
    renderCourseSection({}, { timeline });
    expect(screen.getAllByRole('img', { name: /school days after the due date/ })).toHaveLength(1);
  });

  it('without a timeline the plain due date stays', () => {
    renderCourseSection({});
    expect(screen.getByText('Due: 2026-04-12')).toBeInTheDocument();
  });
});

describe('CourseSection test attempt link (linked quizzes)', () => {
  it('shows an Attempt link on the row, keyed by Schoology assignment id', () => {
    renderCourseSection({}, {}, {
      studentName: 'Ada Lovelace',
      attemptLinks: { 'sa-10': { url: 'https://schoology.hkis.edu.hk/assignment/9/assessment_results/student_stats/u/2', completedAt: '2026-10-09 09:31' } },
    });
    const link = screen.getByRole('link', { name: "Attempt: open Ada Lovelace's test attempt in Schoology" });
    expect(link).toHaveAttribute('href', expect.stringContaining('/student_stats/u/2'));
  });

  it('shows none for an assignment without an attempt', () => {
    renderCourseSection({}, {}, { studentName: 'Ada Lovelace', attemptLinks: { 'other': { url: 'https://x.example/a' } } });
    expect(screen.queryByRole('link', { name: /test attempt/i })).not.toBeInTheDocument();
  });
});
