import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import PastCoursesPanel from './PastCoursesPanel.jsx';
import { getPastSections, importCourse } from '../services/api.js';

vi.mock('../services/api.js', () => ({
  getPastSections: vi.fn(),
  importCourse: vi.fn(),
}));

const ARCHIVED = [
  { id: 10, course_name: 'Old Robotics', archived: 1,
    grading_period: 'Semester 1: 08/14/2024 - 01/11/2025', synced_at: '2025-01-20T00:00:00Z' },
];

const DISCOVERED = {
  available: true,
  sections: [
    { courseTitle: 'Photography 7', courseCode: null, sectionId: '7004', imported: false, noCourseCode: true },
    { courseTitle: 'Drama 8', courseCode: 'DRA8', sectionId: '7005', imported: false, noCourseCode: false },
  ],
};

function renderPanel(props = {}) {
  return render(
    <PastCoursesPanel
      courses={props.courses || ARCHIVED}
      loggedIn={props.loggedIn ?? true}
      onLogin={props.onLogin || (() => {})}
      busy={false}
    />
  );
}

function expand() {
  fireEvent.click(screen.getByLabelText(/Expand past courses/));
}

beforeEach(() => { vi.clearAllMocks(); });

describe('PastCoursesPanel', () => {
  it('lists imported archived courses grouped by year with Imported ✓', () => {
    renderPanel();
    expand();
    expect(screen.getByText('2024-25')).toBeInTheDocument();
    expect(screen.getByText('Old Robotics')).toBeInTheDocument();
    expect(screen.getByText(/Imported ✓/)).toBeInTheDocument();
  });

  it('discovers not-yet-imported sections, flags no-code, and sizes "Import all"', async () => {
    getPastSections.mockResolvedValue(DISCOVERED);
    renderPanel();
    expand();
    fireEvent.click(screen.getByText(/Check Schoology for past courses/));
    await screen.findByText('Drama 8');
    expect(screen.getByText('Photography 7')).toBeInTheDocument();
    expect(screen.getByText(/no course code/)).toBeInTheDocument();
    expect(screen.getByText(/Import all \(1, excl\. no-code\)/)).toBeInTheDocument();
  });

  it('Import all imports only code-bearing, not-yet-imported sections', async () => {
    getPastSections.mockResolvedValue(DISCOVERED);
    importCourse.mockResolvedValue({});
    renderPanel();
    expand();
    fireEvent.click(screen.getByText(/Check Schoology for past courses/));
    await screen.findByText('Drama 8');
    fireEvent.click(screen.getByText(/Import all/));
    await waitFor(() => expect(importCourse).toHaveBeenCalledTimes(1));
    expect(importCourse).toHaveBeenCalledWith('7005');
  });

  it('shows the login prompt when discovery is unavailable', async () => {
    getPastSections.mockResolvedValue({ available: false, reason: 'no_session' });
    const onLogin = vi.fn();
    renderPanel({ onLogin });
    expand();
    fireEvent.click(screen.getByText(/Check Schoology for past courses/));
    await screen.findByText(/Log in to Schoology/);
    fireEvent.click(screen.getByText(/Log in to Schoology/));
    expect(onLogin).toHaveBeenCalled();
  });

  it('per-course Import marks the row Imported ✓ in place (stays visible)', async () => {
    getPastSections.mockResolvedValue(DISCOVERED);
    importCourse.mockResolvedValue({});
    renderPanel();
    expand();
    fireEvent.click(screen.getByText(/Check Schoology for past courses/));
    await screen.findByText('Drama 8');
    const dramaRow = screen.getByText('Drama 8').closest('.sync-course');
    fireEvent.click(within(dramaRow).getByText('Import'));
    await waitFor(() => expect(importCourse).toHaveBeenCalledWith('7005'));
    // The row stays visible and flips to a disabled "Imported ✓" button (not removed).
    const dramaRowAfter = screen.getByText('Drama 8').closest('.sync-course');
    const doneBtn = within(dramaRowAfter).getByRole('button');
    expect(doneBtn).toHaveTextContent('Imported ✓');
    expect(doneBtn).toBeDisabled();
    // Drama 8 was the only code-bearing section → "Import all" disappears once it's imported.
    expect(screen.queryByText(/Import all/)).not.toBeInTheDocument();
  });

  it('renders an already-imported discovered section as Imported ✓ (no Import button)', async () => {
    getPastSections.mockResolvedValue({
      available: true,
      sections: [
        { courseTitle: 'History 9', courseCode: 'HIS9', sectionId: '7010', imported: true, noCourseCode: false },
        { courseTitle: 'Drama 8', courseCode: 'DRA8', sectionId: '7005', imported: false, noCourseCode: false },
      ],
    });
    renderPanel();
    expand();
    fireEvent.click(screen.getByText(/Check Schoology for past courses/));
    await screen.findByText('History 9');
    const historyRow = screen.getByText('History 9').closest('.sync-course');
    const doneBtn = within(historyRow).getByRole('button');
    expect(doneBtn).toHaveTextContent('Imported ✓');
    expect(doneBtn).toBeDisabled();
    // The not-yet-imported one is still importable; Import all counts only it.
    expect(screen.getByText(/Import all \(1, excl\. no-code\)/)).toBeInTheDocument();
  });

  it('surfaces an error when an import fails', async () => {
    getPastSections.mockResolvedValue(DISCOVERED);
    importCourse.mockRejectedValue(new Error('Section not accessible'));
    renderPanel();
    expand();
    fireEvent.click(screen.getByText(/Check Schoology for past courses/));
    await screen.findByText('Drama 8');
    const dramaRow = screen.getByText('Drama 8').closest('.sync-course');
    fireEvent.click(within(dramaRow).getByText('Import'));
    expect(await screen.findByText('Section not accessible')).toBeInTheDocument();
  });
});
