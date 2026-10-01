import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from './Dashboard.jsx';
import * as api from '../services/api.js';

vi.mock('../services/api.js', () => ({
  getCourses: vi.fn(),
  getCoursesByView: vi.fn(),
  getSyncStatus: vi.fn(),
  toggleCourseVisibility: vi.fn(),
  discoverArchivedCourses: vi.fn(),
  importCourse: vi.fn(),
  triggerMasteryLogin: vi.fn(),
  getTriage: vi.fn(),
  recordReferral: vi.fn(),
  getReferrals: vi.fn(),
  undoReferral: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  api.getCoursesByView.mockResolvedValue([]);
  api.getCourses.mockResolvedValue([]);
  api.getSyncStatus.mockResolvedValue({});
  api.getTriage.mockResolvedValue(null);
});

function renderDashboard() {
  return render(<MemoryRouter><Dashboard /></MemoryRouter>);
}

describe('Dashboard — Current tab', () => {
  it('groups current courses by semester, Full Year first then S1 then S2', async () => {
    api.getCoursesByView.mockResolvedValue([
      { id: 1, course_name: 'Mobile Game Development', grading_period: 'Semester 2: 01/06/2026 - 06/15/2026' },
      { id: 2, course_name: 'Mobile App Development', grading_period: 'Semester 1: 08/14/2025 - 01/11/2026' },
      { id: 3, course_name: 'AI & Machine Learning', grading_period: '2025-2026: 08/14/2025 - 06/01/2026' },
    ]);
    const { container } = renderDashboard();

    const heads = await screen.findAllByRole('heading', { level: 4 });
    expect(heads.map(h => h.textContent)).toEqual(['Full Year', 'Semester 1', 'Semester 2']);
    heads.forEach(h => expect(h).toHaveClass('semester-subhead'));

    // Cards follow their heading, in the same order
    const labels = [...container.querySelectorAll('h4, .card h3')].map(el => el.textContent);
    expect(labels).toEqual([
      'Full Year', 'AI & Machine Learning',
      'Semester 1', 'Mobile App Development',
      'Semester 2', 'Mobile Game Development',
    ]);
  });

  it('shows the empty state when there are no current courses', async () => {
    renderDashboard();
    expect(await screen.findByText(/No courses synced yet/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 4 })).not.toBeInTheDocument();
  });
});

describe('Dashboard — enrolled-student count badge', () => {
  it('shows the enrolment count on a current course card', async () => {
    api.getCoursesByView.mockResolvedValue([
      { id: 1, course_name: 'AI & Machine Learning', student_count: 24 },
    ]);
    renderDashboard();
    expect(await screen.findByText('24 students')).toBeInTheDocument();
  });

  it('says "1 student" when a single student is enrolled', async () => {
    api.getCoursesByView.mockResolvedValue([
      { id: 1, course_name: 'Robotics', student_count: 1 },
    ]);
    renderDashboard();
    expect(await screen.findByText('1 student')).toBeInTheDocument();
  });

  it('omits the badge for empty course shells rather than showing "0 students"', async () => {
    api.getCoursesByView.mockResolvedValue([
      { id: 1, course_name: 'Master Template', student_count: 0 },
    ]);
    renderDashboard();
    await screen.findByText('Master Template');
    expect(screen.queryByText(/student/)).not.toBeInTheDocument();
  });

  it('omits the badge when the course carries no student_count at all', async () => {
    api.getCoursesByView.mockResolvedValue([
      { id: 1, course_name: 'Mobile App Development' },
    ]);
    renderDashboard();
    await screen.findByText('Mobile App Development');
    expect(screen.queryByText(/student/)).not.toBeInTheDocument();
  });

  it('shows the enrolment count on archived course cards too', async () => {
    api.getCoursesByView.mockImplementation(view =>
      Promise.resolve(view === 'archived'
        ? [{ id: 9, course_name: 'AP CS A', grading_period: '2023-2024: 08/14/2023 - 06/01/2024', student_count: 12 }]
        : [])
    );
    renderDashboard();
    fireEvent.click(await screen.findByText('Archived'));
    expect(await screen.findByText('12 students')).toBeInTheDocument();
  });
});

describe('Dashboard — Archived tab', () => {
  it('shows the archived-course discovery surface', async () => {
    renderDashboard();
    fireEvent.click(await screen.findByText('Archived'));
    expect(
      await screen.findByRole('button', { name: /Check Schoology for archived courses/ })
    ).toBeInTheDocument();
  });

  it('no longer renders the manual "Add an archived course" form', async () => {
    renderDashboard();
    fireEvent.click(await screen.findByText('Archived'));
    // wait for the panel (its button) to be present before asserting the form is gone
    await screen.findByRole('button', { name: /Check Schoology for archived courses/ });
    expect(screen.queryByText('Add an archived course')).not.toBeInTheDocument();
    expect(screen.queryByText(/Section ID/)).not.toBeInTheDocument();
  });
});

describe('Dashboard — triage', () => {
  it('shows triage panels and per-course chips on the Current tab', async () => {
    api.getCoursesByView.mockResolvedValue([
      { id: 5, course_name: 'AP Computer Science Principles', grading_period: 'Semester 1: 08/14/2026 - 01/11/2027', student_count: 24 },
    ]);
    api.getTriage.mockResolvedValue({
      settings: { referralLimitDays: 8, feedbackLimitDays: 10, warnLeadDays: 3, showFormativeDefault: false, makeUpAmberDays: 1, makeUpRedDays: 3 },
      includeFormative: false, historyCount: 0, lastSyncAt: null, makeUpsUnchecked: 0,
      calendar: { source: 'powerschool', totalSchoolDays: 164, today: { schoolDayNumber: 35, cycleLetter: 'A' } },
      lateWork: [{ kind: 'outstanding', studentId: 1, studentName: 'Maya Chen', courseId: 5, courseName: 'AP Computer Science Principles', assignmentId: 9, schoologyAssignmentId: 'a9', title: 'CP2', dueDate: '2026-10-05', daysLate: 9, tone: 'red', approx: false }],
      feedbackOwed: [{ assignmentId: 4, schoologyAssignmentId: 'a4', courseId: 5, courseName: 'AP Computer Science Principles', title: 'CP1', dueDate: '2026-09-17', aligned: true, owed: 7, submittedTotal: 24, oldestWaitDays: 8, tone: 'amber', approx: false }],
      makeUps: [
        { studentId: 2, studentName: 'Noah Park', courseId: 5, courseName: 'AP Computer Science Principles', assignmentId: 20, schoologyAssignmentId: 'q20', title: 'Unit 1 test', dueDate: '2026-10-13', daysSince: 3, tone: 'red', approx: false, extension: null },
        { studentId: 3, studentName: 'Zoe Tan', courseId: 5, courseName: 'AP Computer Science Principles', assignmentId: 20, schoologyAssignmentId: 'q20', title: 'Unit 1 test', dueDate: '2026-10-13', daysSince: 1, tone: 'amber', approx: false, extension: null },
      ],
    });
    renderDashboard();
    expect(await screen.findByText('Maya Chen')).toBeInTheDocument();
    expect(await screen.findByText('1 at limit')).toBeInTheDocument();
    expect(screen.getByText('7 to grade · 8d')).toBeInTheDocument();
    expect(screen.getByText('2 make-ups')).toHaveClass('badge-red'); // red when any make-up is red
    expect(await screen.findByText('Noah Park')).toBeInTheDocument();
    expect(screen.getByText('School day 35 of 164 · Day A')).toBeInTheDocument();
  });

  it('no triage on the Archived tab', async () => {
    renderDashboard();
    fireEvent.click(await screen.findByText('Archived'));
    expect(api.getTriage).toHaveBeenCalledTimes(1); // only the initial Current-tab mount
  });
});
