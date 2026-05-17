import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CourseSection } from './StudentPage.jsx';

vi.mock('../components/MasteryPerformanceSummary.jsx', () => ({ default: () => null }));

function renderCourseSection(flagsByAssignment) {
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
});
