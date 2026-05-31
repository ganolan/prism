import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import ArchivedCoursesPanel from './ArchivedCoursesPanel.jsx';
import { discoverArchivedCourses, importCourse, triggerMasteryLogin } from '../services/api.js';

vi.mock('../services/api.js', () => ({
  discoverArchivedCourses: vi.fn(),
  importCourse: vi.fn(),
  triggerMasteryLogin: vi.fn(),
}));

const DISCOVERED = {
  available: true,
  sections: [
    { courseTitle: 'Photography 7', courseCode: null, sectionId: '7004', imported: false, noCourseCode: true },
    { courseTitle: 'Drama 8', courseCode: 'DRA8', sectionId: '7005', imported: false, noCourseCode: false },
  ],
};

function renderPanel(props = {}) {
  return render(<ArchivedCoursesPanel onImported={props.onImported || (() => {})} />);
}

beforeEach(() => { vi.clearAllMocks(); });

describe('ArchivedCoursesPanel', () => {
  it('discovers not-yet-imported sections, flags no-code, and sizes "Import all"', async () => {
    discoverArchivedCourses.mockResolvedValue(DISCOVERED);
    renderPanel();
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    await screen.findByText('Drama 8');
    expect(screen.getByText('Photography 7')).toBeInTheDocument();
    expect(screen.getByText(/no course code/)).toBeInTheDocument();
    expect(screen.getByText(/Import all \(1, excl\. no-code\)/)).toBeInTheDocument();
  });

  it('transforms the Check button in place into Import all once the queue appears', async () => {
    discoverArchivedCourses.mockResolvedValue(DISCOVERED);
    renderPanel();
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    await screen.findByText('Drama 8');
    expect(screen.queryByText(/Check Schoology for archived courses/)).not.toBeInTheDocument();
    expect(screen.getByText(/Import all \(1, excl\. no-code\)/)).toBeInTheDocument();
  });

  it('Import all imports only code-bearing, not-yet-imported sections', async () => {
    discoverArchivedCourses.mockResolvedValue(DISCOVERED);
    importCourse.mockResolvedValue({});
    renderPanel();
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    await screen.findByText('Drama 8');
    fireEvent.click(screen.getByText(/Import all/));
    await waitFor(() => expect(importCourse).toHaveBeenCalledTimes(1));
    expect(importCourse).toHaveBeenCalledWith('7005');
  });

  it('logs in on demand and auto-re-runs discovery', async () => {
    discoverArchivedCourses
      .mockResolvedValueOnce({ available: false, reason: 'no_session' })
      .mockResolvedValueOnce(DISCOVERED);
    triggerMasteryLogin.mockResolvedValue({});
    renderPanel();
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    await screen.findByText(/Log in to Schoology/);
    fireEvent.click(screen.getByText(/Log in to Schoology/));
    await waitFor(() => expect(triggerMasteryLogin).toHaveBeenCalled());
    // auto re-check surfaces the queue without another Check click
    await screen.findByText('Drama 8');
    expect(discoverArchivedCourses).toHaveBeenCalledTimes(2);
    // and the login prompt is cleared once the session is confirmed
    expect(screen.queryByText(/Log in to Schoology/)).not.toBeInTheDocument();
  });

  it('per-course Import removes the row from the queue and refreshes the Dashboard', async () => {
    discoverArchivedCourses.mockResolvedValue(DISCOVERED);
    importCourse.mockResolvedValue({});
    const onImported = vi.fn();
    renderPanel({ onImported });
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    await screen.findByText('Drama 8');
    const dramaRow = screen.getByText('Drama 8').closest('.archived-import-row');
    fireEvent.click(within(dramaRow).getByText('Import'));
    await waitFor(() => expect(importCourse).toHaveBeenCalledWith('7005'));
    await waitFor(() => expect(screen.queryByText('Drama 8')).not.toBeInTheDocument());
    expect(onImported).toHaveBeenCalled();
    expect(screen.queryByText(/Import all/)).not.toBeInTheDocument();
  });

  it('excludes already-imported discovered sections from the queue', async () => {
    discoverArchivedCourses.mockResolvedValue({
      available: true,
      sections: [
        { courseTitle: 'History 9', courseCode: 'HIS9', sectionId: '7010', imported: true, noCourseCode: false },
        { courseTitle: 'Drama 8', courseCode: 'DRA8', sectionId: '7005', imported: false, noCourseCode: false },
      ],
    });
    renderPanel();
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    await screen.findByText('Drama 8');
    expect(screen.queryByText('History 9')).not.toBeInTheDocument();
    expect(screen.getByText(/Found on Schoology \(2\) — 1 not yet imported/)).toBeInTheDocument();
    expect(screen.getByText(/Import all \(1, excl\. no-code\)/)).toBeInTheDocument();
  });

  it('surfaces an error when an import fails', async () => {
    discoverArchivedCourses.mockResolvedValue(DISCOVERED);
    importCourse.mockRejectedValue(new Error('Section not accessible'));
    renderPanel();
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    await screen.findByText('Drama 8');
    const dramaRow = screen.getByText('Drama 8').closest('.archived-import-row');
    fireEvent.click(within(dramaRow).getByText('Import'));
    expect(await screen.findByText('Section not accessible')).toBeInTheDocument();
  });

  it('keeps the login prompt and surfaces an error when login fails', async () => {
    discoverArchivedCourses.mockResolvedValue({ available: false, reason: 'no_session' });
    triggerMasteryLogin.mockRejectedValue(new Error('Login window closed'));
    renderPanel();
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    await screen.findByText(/Log in to Schoology/);
    fireEvent.click(screen.getByText(/Log in to Schoology/));
    expect(await screen.findByText('Login window closed')).toBeInTheDocument();
    // login failed → discovery was not re-run, and the prompt is still offered
    expect(screen.getByText(/Log in to Schoology/)).toBeInTheDocument();
    expect(discoverArchivedCourses).toHaveBeenCalledTimes(1);
  });
});
