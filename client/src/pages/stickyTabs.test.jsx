// Wiring tests for the sticky-tab behaviour on the pages that have tab bars.
// The mechanism itself is covered by src/hooks/useStickyTab.test.jsx — these
// only prove each page is hooked up with the right storage key and query param.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import Dashboard from './Dashboard.jsx';
import CoursePage from './CoursePage.jsx';
import * as api from '../services/api.js';

vi.mock('../services/api.js');

function LocationProbe() {
  const { search } = useLocation();
  return <span data-testid="search">{search}</span>;
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();

  vi.mocked(api.getCourses).mockResolvedValue([]);
  vi.mocked(api.getCoursesByView).mockResolvedValue([]);
  vi.mocked(api.getSyncStatus).mockResolvedValue({});
  vi.mocked(api.getCourse).mockResolvedValue({ id: 5, course_name: 'Robotics' });
  vi.mocked(api.getCourseStudents).mockResolvedValue([]);
  vi.mocked(api.getGradebook).mockResolvedValue({ assignments: [], students: [] });
  vi.mocked(api.getMasteryForCourse).mockResolvedValue(null);
  vi.mocked(api.getGradingScales).mockResolvedValue({});
  vi.mocked(api.getProficiencyScale).mockResolvedValue({ schoologyScaleId: 1, levels: [] });
});

describe('Dashboard sticky tab', () => {
  const renderAt = (entry) => render(
    <MemoryRouter initialEntries={[entry]}>
      <LocationProbe />
      <Dashboard />
    </MemoryRouter>,
  );

  it('opens on the Archived tab when the URL says so', async () => {
    renderAt('/?tab=archived');
    await waitFor(() => expect(screen.getByText('Archived')).toHaveClass('active'));
    expect(screen.getByText('Current')).not.toHaveClass('active');
  });

  it('opens on Current by default', async () => {
    renderAt('/');
    await waitFor(() => expect(screen.getByText('Current')).toHaveClass('active'));
  });

  it('puts the chosen tab in the URL', async () => {
    renderAt('/');
    fireEvent.click(await screen.findByText('Archived'));
    expect(screen.getByTestId('search')).toHaveTextContent('?tab=archived');
  });

  it('reopens on the tab last used when returning without a param', async () => {
    const first = renderAt('/');
    fireEvent.click(await screen.findByText('Archived'));
    first.unmount();

    renderAt('/');
    await waitFor(() => expect(screen.getByText('Archived')).toHaveClass('active'));
  });
});

describe('CoursePage sticky tab', () => {
  const renderAt = (entry) => render(
    <MemoryRouter initialEntries={[entry]}>
      <LocationProbe />
      <Routes>
        <Route path="/course/:id" element={<CoursePage />} />
      </Routes>
    </MemoryRouter>,
  );

  it('opens on the Gradebook tab when the URL says so', async () => {
    renderAt('/course/5?tab=gradebook');
    await waitFor(() => expect(screen.getByText('Gradebook')).toHaveClass('active'));
    expect(screen.getByText('Roster')).not.toHaveClass('active');
  });

  it('opens on Roster by default', async () => {
    renderAt('/course/5');
    await waitFor(() => expect(screen.getByText('Roster')).toHaveClass('active'));
  });

  it('reopens on the tab last used when returning via a bare "back to course" link', async () => {
    const first = renderAt('/course/5');
    fireEvent.click(await screen.findByText('Assessments'));
    first.unmount();

    // AssessmentSummaryPage's back link points at /course/:id with no query.
    renderAt('/course/5');
    await waitFor(() => expect(screen.getByText('Assessments')).toHaveClass('active'));
  });
});

describe('CoursePage sticky gradebook filter (#144)', () => {
  const renderAt = (entry) => render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/course/:id" element={<CoursePage />} />
      </Routes>
    </MemoryRouter>,
  );
  const pill = (name) => screen.findByRole('button', { name: new RegExp(`^${name}`) });

  beforeEach(() => {
    localStorage.clear();
    vi.mocked(api.getGradebook).mockResolvedValue({
      assignments: [
        { id: 1, title: 'Project', schoology_assignment_id: 'sa-1', aligned: 1, published: 1, due_date: null },
        { id: 2, title: 'Quiz', schoology_assignment_id: 'sa-2', aligned: 0, published: 1, due_date: null },
        { id: 3, title: 'Draft test', schoology_assignment_id: 'sa-3', aligned: 1, published: 0, due_date: null },
      ],
      students: [], grades: {}, grading_scales: {},
    });
  });

  it('keeps the filter after leaving the page and coming back', async () => {
    const first = renderAt('/course/5?tab=gradebook');
    fireEvent.click(await pill('Formative'));
    fireEvent.click(await pill('Unpublished'));
    first.unmount();

    renderAt('/course/5?tab=gradebook');
    expect(await pill('Formative')).toHaveAttribute('aria-pressed', 'false');
    expect(await pill('Unpublished')).toHaveAttribute('aria-pressed', 'true');
    expect(await pill('Summative')).toHaveAttribute('aria-pressed', 'true');
  });

  it('uses one setting for every course', async () => {
    const first = renderAt('/course/5?tab=gradebook');
    fireEvent.click(await pill('Unpublished'));
    first.unmount();

    renderAt('/course/7?tab=gradebook');
    expect(await pill('Unpublished')).toHaveAttribute('aria-pressed', 'true');
  });
});
