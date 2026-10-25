import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, screen, fireEvent, within, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import CoursePage from './CoursePage.jsx';
import { DataVersionContext } from '../hooks/useDataVersion.jsx';
import * as api from '../services/api.js';
import { setPrivateDetails } from '../lib/privateDetails.js';

vi.mock('../services/api.js');

// Keep the page in its loading state by never resolving the data fetches. The
// effect still runs (on mount and on dependency change), so we can assert the
// gradebook is re-pulled when the data version bumps — without rendering the
// heavy roster/gradebook UI.
function pending() {
  return new Promise(() => {});
}

function tree(version) {
  return (
    <DataVersionContext.Provider value={version}>
      <MemoryRouter initialEntries={['/course/5']}>
        <Routes>
          <Route path="/course/:id" element={<CoursePage />} />
        </Routes>
      </MemoryRouter>
    </DataVersionContext.Provider>
  );
}

beforeEach(() => {
  vi.clearAllMocks(); // call counts are asserted; don't let them accumulate across tests
  localStorage.clear(); // Private details reads as on (test-setup.js) unless a test turns it off
  vi.mocked(api.getCourse).mockReturnValue(pending());
  vi.mocked(api.getCourseStudents).mockReturnValue(pending());
  vi.mocked(api.getGradebook).mockReturnValue(pending());
  vi.mocked(api.getMasteryForCourse).mockReturnValue(pending());
  vi.mocked(api.getProficiencyScale).mockResolvedValue({
    schoologyScaleId: 21337256,
    levels: [
      { code: 'ED', label: 'Exhibiting Depth', points: 100, gradeScaled: '87.50' },
      { code: 'EX', label: 'Exhibiting', points: 75, gradeScaled: '62.50' },
      { code: 'D', label: 'Developing', points: 50, gradeScaled: '37.50' },
      { code: 'EM', label: 'Emerging', points: 25, gradeScaled: '12.50' },
      { code: 'IE', label: 'Insufficient Evidence', points: 0, gradeScaled: '0.00' },
    ],
  });
});

describe('CoursePage data refresh', () => {
  it('re-fetches the gradebook when the data version changes (e.g. after a sync)', async () => {
    const { rerender } = render(tree(0));

    await waitFor(() => expect(api.getGradebook).toHaveBeenCalledTimes(1));
    expect(api.getGradebook).toHaveBeenCalledWith('5');

    // A sync completes → DataVersionContext bumps → the page re-pulls.
    rerender(tree(1));

    await waitFor(() => expect(api.getGradebook).toHaveBeenCalledTimes(2));
  });

  it('does not re-fetch on an unrelated re-render (stable data version)', async () => {
    const { rerender } = render(tree(0));
    await waitFor(() => expect(api.getGradebook).toHaveBeenCalledTimes(1));

    rerender(tree(0));
    // Give any errant effect a chance to fire before asserting it did not.
    await new Promise((r) => setTimeout(r, 0));
    expect(api.getGradebook).toHaveBeenCalledTimes(1);
  });
});

describe('CoursePage header — block', () => {
  it('names the block in the meta line, ahead of the Schoology section', async () => {
    vi.mocked(api.getCourse).mockResolvedValue({ id: 5, course_name: 'AP COMPUTER SCIENCE PRINCIPLES', section_name: '4(A-B)', block_number: 7, studentCount: 19 });
    vi.mocked(api.getCourseStudents).mockResolvedValue([]);
    vi.mocked(api.getGradebook).mockResolvedValue({ assignments: [], students: [], grades: {}, folders: [], grading_scales: {} });
    vi.mocked(api.getMasteryForCourse).mockResolvedValue({ topics: [], scores: [], rollups: [], alignments: [] });
    const { findByText, container } = render(tree(0));
    await findByText('Block 7');
    const items = [...container.querySelectorAll('.course-header__meta-item')].map(e => e.textContent);
    expect(items.slice(0, 2)).toEqual(['Block 7', '4(A-B)']);
  });
});

describe('CoursePage triage', () => {
  function loaded(course) {
    vi.mocked(api.getCourse).mockResolvedValue({ id: 5, course_name: 'AP CSP', studentCount: 0, ...course });
    vi.mocked(api.getCourseStudents).mockResolvedValue([]);
    vi.mocked(api.getGradebook).mockResolvedValue({ assignments: [], students: [], grades: {}, folders: [], grading_scales: {} });
    vi.mocked(api.getMasteryForCourse).mockResolvedValue({ topics: [], scores: [], rollups: [], alignments: [] });
  }

  it('fetches triage for a current course', async () => {
    loaded({ archived: 0 });
    const { findByText } = render(tree(0));
    await findByText('AP CSP');
    await waitFor(() => expect(api.getTriage).toHaveBeenCalled());
  });

  const TRIAGE = {
    settings: { referralLimitDays: 8, feedbackLimitDays: 10, warnLeadDays: 3, showFormativeDefault: false, makeUpAmberDay: 2, makeUpRedDay: 4 },
    includeFormative: false, historyCount: 0, lastSyncAt: null, makeUpsUnchecked: 0, calendar: null, makeUps: [],
    lateWork: [
      { kind: 'outstanding', studentId: 1, studentName: 'Maya Chen', courseId: 5, courseName: 'AP CSP', assignmentId: 9, schoologyAssignmentId: 'a9', title: 'CP2', day: 10, tone: 'red', approx: false },
      { kind: 'outstanding', studentId: 2, studentName: 'Zoe Tan', courseId: 5, courseName: 'AP CSP', assignmentId: 9, schoologyAssignmentId: 'a9', title: 'CP2', day: 3, tone: 'green', approx: false },
    ],
    feedbackOwed: [{ assignmentId: 4, schoologyAssignmentId: 'a4', courseId: 5, courseName: 'AP CSP', title: 'CP1', aligned: true, owed: 7, submittedTotal: 9, day: 12, tone: 'red', approx: false }],
  };
  function renderAt(url) {
    return render(
      <MemoryRouter initialEntries={[url]}>
        <Routes><Route path="/course/:id" element={<CoursePage />} /></Routes>
      </MemoryRouter>,
    );
  }
  const rail = () => screen.queryByRole('complementary', { name: 'Triage' });

  it('the triage rail sits beside the tab content (after it in the DOM) on every tab but Gradebook and Roster', async () => {
    loaded({ archived: 0 });
    vi.mocked(api.getTriage).mockResolvedValue(TRIAGE);
    const { container } = renderAt('/course/5?tab=assessments');
    const aside = await screen.findByRole('complementary', { name: 'Triage' });
    const layout = container.querySelector('.triage-layout');
    expect(layout.firstElementChild).toHaveClass('triage-layout__main');
    expect(layout.lastElementChild).toBe(aside);
    expect(screen.queryByRole('button', { name: /^Triage/ })).not.toBeInTheDocument();
  });

  it('on the Gradebook tab the rail is hidden; "Triage ▸" (with the red count) toggles it back in', async () => {
    loaded({ archived: 0 });
    vi.mocked(api.getTriage).mockResolvedValue(TRIAGE);
    renderAt('/course/5?tab=gradebook');
    const toggle = await screen.findByRole('button', { name: /^Triage/ });
    await waitFor(() => expect(within(toggle).getByText('2')).toHaveClass('badge-red')); // 1 late to refer + 1 feedback overdue
    expect(toggle).toHaveTextContent('Triage 2 ▸');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(rail()).not.toBeInTheDocument();
    expect(document.querySelector('.triage-rail')).toHaveAttribute('hidden');
    fireEvent.click(toggle);
    expect(rail()).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', rail().id);
    expect(toggle).toHaveTextContent('Hide triage');
    fireEvent.click(toggle);
    expect(rail()).not.toBeInTheDocument();
  });

  it('leaving the Gradebook tab shows the rail again', async () => {
    loaded({ archived: 0 });
    vi.mocked(api.getTriage).mockResolvedValue(TRIAGE);
    renderAt('/course/5?tab=gradebook');
    await screen.findByRole('button', { name: /^Triage/ });
    fireEvent.click(screen.getByRole('button', { name: 'Assessments' }));
    expect(await screen.findByRole('complementary', { name: 'Triage' })).toBeInTheDocument();
  });

  // #192: on the Roster tab the rail is shown by default while Private details is on and is not in the
  // page while it is off; Triage ▸ toggles it either way. With the switch off the rail (if opened) and
  // the red count hold nothing private (#197).
  it('on the Roster tab the rail follows Private details; Triage ▸ toggles it; the red count needs the switch', async () => {
    setPrivateDetails(false);
    loaded({ archived: 0 });
    vi.mocked(api.getTriage).mockResolvedValue(TRIAGE);
    const { container } = renderAt('/course/5?tab=roster');
    const toggle = await screen.findByRole('button', { name: /^Triage/ });
    await waitFor(() => expect(api.getTriage).toHaveBeenCalledWith({ courseId: '5', includeFormative: false }));
    expect(document.querySelector('.triage-rail')).toBeNull();
    expect(toggle.querySelector('.badge-red')).toBeNull();
    expect(toggle).toHaveTextContent('Triage ▸');
    // The main column keeps the width it has beside the rail, rail or no rail.
    expect(container.querySelector('.triage-layout')).toHaveClass('triage-layout--fixed-main');

    // Opened with the switch off, the rail holds only the shared box.
    fireEvent.click(toggle);
    const closed = await screen.findByRole('complementary', { name: 'Triage' });
    expect(within(closed).getByText('Triage is private.')).toBeInTheDocument();
    expect(closed).not.toHaveTextContent('Maya Chen');

    // Turned on, the rail is shown by default.
    act(() => setPrivateDetails(true));
    expect(await screen.findByRole('complementary', { name: 'Triage' })).toHaveTextContent('Maya Chen');
    expect(toggle).toHaveTextContent('Hide triage');
    fireEvent.click(toggle);
    expect(document.querySelector('.triage-rail')).toBeNull();
    await waitFor(() => expect(within(toggle).getByText('2')).toHaveClass('badge-red'));
    fireEvent.click(toggle);
    expect(await screen.findByRole('complementary', { name: 'Triage' })).toBeInTheDocument();

    act(() => setPrivateDetails(false));
    expect(document.querySelector('.triage-rail')).toBeNull();
    expect(toggle.querySelector('.badge-red')).toBeNull();
  });

  // The open/closed state of Triage ▸ is per visit to a tab: a rail opened on Gradebook must
  // not follow the teacher to the Roster tab, where a projected screen may show it.
  it('a rail opened on the Gradebook tab is not in the page after switching to the Roster tab', async () => {
    setPrivateDetails(false);
    loaded({ archived: 0 });
    vi.mocked(api.getTriage).mockResolvedValue(TRIAGE);
    renderAt('/course/5?tab=gradebook');
    fireEvent.click(await screen.findByRole('button', { name: /^Triage/ }));
    expect(rail()).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Roster' }));
    await screen.findByRole('group', { name: 'Roster view' });
    expect(document.querySelector('.triage-rail')).toBeNull();
    expect(screen.getByRole('button', { name: /^Triage/ })).toHaveAttribute('aria-expanded', 'false');
  });

  // #197: the switch lives in the sidebar; the course page has none of its own, and with it off the
  // Gradebook, Assessments and Analytics tabs draw only the shared box.
  it('with Private details off, Gradebook, Assessments and Analytics show only the PrivateHidden box', async () => {
    setPrivateDetails(false);
    loaded({ archived: 0 });
    vi.mocked(api.getTriage).mockResolvedValue(TRIAGE);
    vi.mocked(api.getCourseAnalytics).mockResolvedValue({ distributions: [], trend: [] });
    const { container } = renderAt('/course/5?tab=gradebook');
    expect(await screen.findByText('Grades are private.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Private details' })).not.toBeInTheDocument();
    expect(container.querySelector('.gradebook-table, table')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Assessments' }));
    expect(screen.getByText('Assessments and their marking progress are private.')).toBeInTheDocument();
    expect(within(rail()).getByText('Triage is private.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Analytics' }));
    expect(screen.getByText('Class results are private.')).toBeInTheDocument();
    expect(api.getCourseAnalytics).not.toHaveBeenCalled();
    act(() => setPrivateDetails(true));
    expect(screen.queryByText('Class results are private.')).not.toBeInTheDocument();
    await waitFor(() => expect(api.getCourseAnalytics).toHaveBeenCalled());
  });

  it('shows no triage (and fetches none) on an archived course page', async () => {
    loaded({ archived: 1 });
    const { findByText, container } = render(tree(0));
    await findByText('AP CSP');
    await new Promise((r) => setTimeout(r, 0));
    expect(api.getTriage).not.toHaveBeenCalled();
    expect(container.querySelector('.triage')).toBeNull();
  });
});
