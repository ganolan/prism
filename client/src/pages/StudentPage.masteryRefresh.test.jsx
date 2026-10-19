// #52: each course on the student page refreshes its mastery from Schoology after the page loads.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const summary = vi.fn(() => null);
vi.mock('../components/MasteryPerformanceSummary.jsx', () => ({ default: (props) => summary(props) }));
vi.mock('../services/api.js', async (orig) => ({
  ...(await orig()),
  refreshMasteryForCourse: vi.fn(),
  getRubricConfig: vi.fn().mockResolvedValue({ reportingCategoryColors: {} }),
}));

import { CourseSection } from './StudentPage.jsx';
import { refreshMasteryForCourse } from '../services/api.js';

const NEW = '2026-10-19T06:00:00.000Z';
const grades = [{ course_id: 1, assignment_id: 10, schoology_assignment_id: 'sa-10', assignment_title: 'Portfolio', score: null, exception: 0, mastery: { topics: [] } }];
const renderSection = (course, props = {}) => render(
  <MemoryRouter>
    <CourseSection course={course} grades={grades} flagsByAssignment={{}} studentUid="u1" scales={{}} studentName="Ada Lee"
      rubrics={{ attachments: {}, palette: {} }} studentId={7} {...props} />
  </MemoryRouter>,
);

beforeEach(() => vi.clearAllMocks());

describe('CourseSection mastery refresh (#52)', () => {
  it('refreshes the course; when Schoology was read, the summary and the page\'s chips reload', async () => {
    refreshMasteryForCourse.mockResolvedValue({ refreshed: true, syncedAt: NEW });
    const onMasteryRefreshed = vi.fn();
    renderSection({ id: 1, course_name: 'Art', archived: 0 }, { onMasteryRefreshed });
    await waitFor(() => expect(onMasteryRefreshed).toHaveBeenCalledTimes(1));
    expect(refreshMasteryForCourse).toHaveBeenCalledWith(1);
    expect(summary).toHaveBeenLastCalledWith(expect.objectContaining({ reloadKey: 1 }));
    expect(screen.getByText(/^Mastery levels read from Schoology at /)).toBeInTheDocument();
  });

  it('fresh: no reload', async () => {
    refreshMasteryForCourse.mockResolvedValue({ refreshed: false, syncedAt: NEW });
    const onMasteryRefreshed = vi.fn();
    renderSection({ id: 1, course_name: 'Art', archived: 0 }, { onMasteryRefreshed });
    await screen.findByText(/^Mastery levels read from Schoology at /);
    expect(onMasteryRefreshed).not.toHaveBeenCalled();
    expect(summary).toHaveBeenLastCalledWith(expect.objectContaining({ reloadKey: 0 }));
  });

  it('an archived course is not refreshed and shows no line', async () => {
    renderSection({ id: 1, course_name: 'Art', archived: 1 });
    await waitFor(() => expect(summary).toHaveBeenCalled());
    expect(refreshMasteryForCourse).not.toHaveBeenCalled();
    expect(screen.queryByText(/Mastery levels/)).toBeNull();
  });
});
