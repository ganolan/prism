import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import ArchivedCoursesPanel from './ArchivedCoursesPanel.jsx';
import { discoverArchivedCourses, importCourse } from '../services/api.js';

vi.mock('../services/api.js', () => ({
  discoverArchivedCourses: vi.fn(),
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
    <ArchivedCoursesPanel
      courses={props.courses || ARCHIVED}
      loggedIn={props.loggedIn ?? true}
      onLogin={props.onLogin || (() => {})}
      onImported={props.onImported || (() => {})}
      busy={false}
    />
  );
}

function expand() {
  fireEvent.click(screen.getByLabelText(/Expand import archived courses/));
}

beforeEach(() => { vi.clearAllMocks(); });

describe('ArchivedCoursesPanel', () => {
  it('lists imported archived courses grouped by year with Imported ✓', () => {
    renderPanel();
    expand();
    expect(screen.getByText('2024-25')).toBeInTheDocument();
    expect(screen.getByText('Old Robotics')).toBeInTheDocument();
    expect(screen.getByText(/Imported ✓/)).toBeInTheDocument();
  });

  it('discovers not-yet-imported sections, flags no-code, and sizes "Import all"', async () => {
    discoverArchivedCourses.mockResolvedValue(DISCOVERED);
    renderPanel();
    expand();
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    await screen.findByText('Drama 8');
    expect(screen.getByText('Photography 7')).toBeInTheDocument();
    expect(screen.getByText(/no course code/)).toBeInTheDocument();
    expect(screen.getByText(/Import all \(1, excl\. no-code\)/)).toBeInTheDocument();
  });

  it('Import all imports only code-bearing, not-yet-imported sections', async () => {
    discoverArchivedCourses.mockResolvedValue(DISCOVERED);
    importCourse.mockResolvedValue({});
    renderPanel();
    expand();
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    await screen.findByText('Drama 8');
    fireEvent.click(screen.getByText(/Import all/));
    await waitFor(() => expect(importCourse).toHaveBeenCalledTimes(1));
    expect(importCourse).toHaveBeenCalledWith('7005');
  });

  it('shows the login prompt when discovery is unavailable', async () => {
    discoverArchivedCourses.mockResolvedValue({ available: false, reason: 'no_session' });
    const onLogin = vi.fn();
    renderPanel({ onLogin });
    expand();
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    await screen.findByText(/Log in to Schoology/);
    fireEvent.click(screen.getByText(/Log in to Schoology/));
    expect(onLogin).toHaveBeenCalled();
  });

  it('per-course Import removes the row from the to-import queue and refreshes the dialog', async () => {
    discoverArchivedCourses.mockResolvedValue(DISCOVERED);
    importCourse.mockResolvedValue({});
    const onImported = vi.fn();
    renderPanel({ onImported });
    expand();
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    await screen.findByText('Drama 8');
    const dramaRow = screen.getByText('Drama 8').closest('.sync-course');
    fireEvent.click(within(dramaRow).getByText('Import'));
    await waitFor(() => expect(importCourse).toHaveBeenCalledWith('7005'));
    // Drama 8 leaves the to-import queue (it now lives in the grouped section above).
    await waitFor(() => expect(screen.queryByText('Drama 8')).not.toBeInTheDocument());
    // and the panel asked the dialog to refetch its course list.
    expect(onImported).toHaveBeenCalled();
    // Drama 8 was the only code-bearing section → "Import all" is gone.
    expect(screen.queryByText(/Import all/)).not.toBeInTheDocument();
  });

  it('excludes already-imported discovered sections from the to-import queue', async () => {
    discoverArchivedCourses.mockResolvedValue({
      available: true,
      sections: [
        { courseTitle: 'History 9', courseCode: 'HIS9', sectionId: '7010', imported: true, noCourseCode: false },
        { courseTitle: 'Drama 8', courseCode: 'DRA8', sectionId: '7005', imported: false, noCourseCode: false },
      ],
    });
    renderPanel();
    expand();
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    await screen.findByText('Drama 8');
    // History 9 is already imported → not shown in the to-import queue.
    expect(screen.queryByText('History 9')).not.toBeInTheDocument();
    // The header still reports the full found count vs. how many remain.
    expect(screen.getByText(/Found on Schoology \(2\) — 1 not yet imported/)).toBeInTheDocument();
    expect(screen.getByText(/Import all \(1, excl\. no-code\)/)).toBeInTheDocument();
  });

  it('surfaces an error when an import fails', async () => {
    discoverArchivedCourses.mockResolvedValue(DISCOVERED);
    importCourse.mockRejectedValue(new Error('Section not accessible'));
    renderPanel();
    expand();
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    await screen.findByText('Drama 8');
    const dramaRow = screen.getByText('Drama 8').closest('.sync-course');
    fireEvent.click(within(dramaRow).getByText('Import'));
    expect(await screen.findByText('Section not accessible')).toBeInTheDocument();
  });
});
