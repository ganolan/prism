import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ArchivedCoursesPanel from './ArchivedCoursesPanel.jsx';
import { discoverArchivedCourses, importCourse } from '../services/api.js';

vi.mock('../services/api.js', () => ({
  discoverArchivedCourses: vi.fn(),
  importCourse: vi.fn(),
}));

const DISCOVERED = {
  available: true,
  sections: [
    { courseTitle: 'Photography 7', courseCode: null, sectionId: '7004', imported: false, noCourseCode: true, gradingPeriod: 'Semester 1: 08/14/2024 - 01/11/2025' },
    { courseTitle: 'Drama 8', courseCode: 'DRA8', sectionId: '7005', imported: false, noCourseCode: false, gradingPeriod: 'Semester 1: 08/14/2024 - 01/11/2025' },
  ],
};

function renderPanel(props = {}) {
  return render(<ArchivedCoursesPanel onImported={props.onImported || (() => {})} />);
}

beforeEach(() => { vi.clearAllMocks(); });

describe('ArchivedCoursesPanel', () => {
  it('discovers not-yet-imported sections and lists them grouped', async () => {
    discoverArchivedCourses.mockResolvedValue(DISCOVERED);
    renderPanel();
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    await screen.findByText('Drama 8');
    expect(screen.getByText('Photography 7')).toBeInTheDocument();
    expect(screen.getByText(/no course code/)).toBeInTheDocument();
    expect(screen.getByText('2024-25')).toBeInTheDocument();
  });

  it('excludes already-imported sections and reports the count', async () => {
    discoverArchivedCourses.mockResolvedValue({
      available: true,
      sections: [
        { courseTitle: 'History 9', courseCode: 'HIS9', sectionId: '7010', imported: true, noCourseCode: false, gradingPeriod: 'Semester 1: 08/14/2023 - 01/11/2024' },
        { courseTitle: 'Drama 8', courseCode: 'DRA8', sectionId: '7005', imported: false, noCourseCode: false, gradingPeriod: 'Semester 1: 08/14/2024 - 01/11/2025' },
      ],
    });
    renderPanel();
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    await screen.findByText('Drama 8');
    expect(screen.queryByText('History 9')).not.toBeInTheDocument();
    expect(screen.getByText(/Found on Schoology \(2\), 1 not yet imported/)).toBeInTheDocument();
  });

  it('imports the selection via a progress modal, then drops it and refreshes', async () => {
    discoverArchivedCourses.mockResolvedValue(DISCOVERED);
    importCourse.mockResolvedValue({ studentsCount: 3, assignmentsCount: 4, gradesCount: 5 });
    const onImported = vi.fn();
    renderPanel({ onImported });
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    await screen.findByText('Drama 8');
    fireEvent.click(screen.getByLabelText('Drama 8'));
    fireEvent.click(screen.getByRole('button', { name: /Import 1 selected/ }));
    await screen.findByText(/Import complete · 1 of 1/);
    expect(importCourse).toHaveBeenCalledWith('7005');
    fireEvent.click(screen.getByRole('button', { name: /done/i }));
    await waitFor(() => expect(screen.queryByText('Drama 8')).not.toBeInTheDocument());
    expect(onImported).toHaveBeenCalled();
  });

  it('Import all imports the year\'s coded sections only', async () => {
    discoverArchivedCourses.mockResolvedValue(DISCOVERED);
    importCourse.mockResolvedValue({ studentsCount: 1, assignmentsCount: 1, gradesCount: 1 });
    renderPanel();
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    await screen.findByText('Drama 8');
    fireEvent.click(screen.getByRole('button', { name: /Import all \(1\)/ }));
    await screen.findByText(/Import complete/);
    expect(importCourse).toHaveBeenCalledWith('7005');
    expect(importCourse).toHaveBeenCalledTimes(1);
  });

  it('shows a failed import in the modal with Retry failed', async () => {
    discoverArchivedCourses.mockResolvedValue(DISCOVERED);
    importCourse.mockRejectedValue(new Error('Section not accessible'));
    const onImported = vi.fn();
    renderPanel({ onImported });
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    await screen.findByText('Drama 8');
    fireEvent.click(screen.getByLabelText('Drama 8'));
    fireEvent.click(screen.getByRole('button', { name: /Import 1 selected/ }));
    expect(await screen.findByText('Section not accessible')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry failed \(1\)/i })).toBeInTheDocument();
    expect(onImported).not.toHaveBeenCalled();
  });

  it('Schoology cannot be read: an error, no sign-in prompt (the REST read needs none, #178)', async () => {
    discoverArchivedCourses.mockResolvedValue({ available: false, reason: 'unavailable' });
    renderPanel();
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    expect(await screen.findByText('Schoology could not be read. Try again in a few minutes.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Log in to Schoology' })).toBeNull();
  });

  it('shows each row\'s sections, and marks one the background import gave up on (#178)', async () => {
    discoverArchivedCourses.mockResolvedValue({ available: true, sections: [
      { courseTitle: 'AI & ML', courseCode: 'A', sectionId: '4', sectionTitle: '4(A-B), 6(A-B)', imported: false, noCourseCode: false, givenUp: true, gradingPeriod: '2023-2024: 08/15/23 - 06/14/24' },
    ] });
    renderPanel();
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    expect(await screen.findByText('4(A-B), 6(A-B)')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'AI & ML 4(A-B), 6(A-B)' })).toBeInTheDocument();
    expect(screen.getByText(/import failed twice/)).toBeInTheDocument();
  });
});
