// Background sync: the student page asks the queue to sync the student's current courses after it loads,
// shows one "Synced …" (the oldest of those courses), and reloads when the sync ends. Each course
// section shows no freshness line of its own.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const summary = vi.fn(() => null);
vi.mock('../components/MasteryPerformanceSummary.jsx', () => ({ default: (props) => summary(props) }));
vi.mock('../services/api.js', () => ({
  getStudent: vi.fn(),
  updateStudent: vi.fn(), updateParentPhone: vi.fn(), createNote: vi.fn(), updateNote: vi.fn(), deleteNote: vi.fn(),
  getAttemptLinks: vi.fn().mockResolvedValue({ links: {} }),
  getRubricConfig: vi.fn().mockResolvedValue({ reportingCategoryColors: {} }),
  ensureSync: vi.fn(),
  getCurrentSync: vi.fn(),
  getSyncRun: vi.fn(),
  startSync: vi.fn(),
}));

import { getStudent, ensureSync, getCurrentSync, getSyncRun, startSync } from '../services/api.js';
import StudentPage, { CourseSection } from './StudentPage.jsx';

const RECENT = new Date().toISOString();
const OLDER = new Date('2026-10-19T03:00:00').toISOString(); // 03:00 local, in any time zone (CI runs in UTC)
const grade = (courseId) => ({ course_id: courseId, assignment_id: 10 + courseId, schoology_assignment_id: `sa-${courseId}`, assignment_title: 'Portfolio', score: null, exception: 0, mastery: { topics: [] } });
const student = {
  id: 7, first_name: 'Ana', last_name: 'Lee', schoology_uid: 'u7', notes: [], flags: [], parents: [], grading_scales: {},
  courses: [
    { id: 1, course_name: 'Art', archived: 0, course_synced_at: RECENT },
    { id: 2, course_name: 'Bio', archived: 0, course_synced_at: OLDER },
    { id: 3, course_name: 'Old', archived: 1, course_synced_at: null },
  ],
  grades: [grade(1), grade(2), grade(3)],
};
const renderPage = () => render(
  <MemoryRouter initialEntries={['/student/7']}>
    <Routes><Route path="/student/:id" element={<StudentPage />} /></Routes>
  </MemoryRouter>,
);
const IDLE = { running: null, runId: null, queued: [], held: [] };

beforeEach(() => {
  vi.clearAllMocks();
  getStudent.mockResolvedValue(student);
  ensureSync.mockResolvedValue({ state: 'fresh' });
  getCurrentSync.mockResolvedValue(IDLE);
});

describe('StudentPage background sync', () => {
  it('asks the queue for the student\'s current courses; one "Synced" time, the oldest; no per-course line', async () => {
    renderPage();
    await waitFor(() => expect(ensureSync).toHaveBeenCalledWith({ kind: 'courses', courseIds: [1, 2] }));
    expect(await screen.findByText('Synced 19/10/2026, 03:00')).toBeInTheDocument();
    expect(screen.queryByText(/Mastery levels/)).toBeNull();
  });

  it('when the sync ends, the page and each course summary reload', async () => {
    ensureSync.mockResolvedValue({ state: 'running', runId: 4 });
    getSyncRun.mockResolvedValue({ id: 4, status: 'completed' });
    renderPage();
    await waitFor(() => expect(getStudent).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(summary).toHaveBeenLastCalledWith(expect.objectContaining({ reloadKey: 1 })));
  });

  it('Sync Courses here queues the student\'s current courses and follows the run', async () => {
    startSync.mockResolvedValue({ runId: 9, state: 'queued', joined: false });
    getCurrentSync.mockResolvedValue({ ...IDLE, running: { runId: 9 }, runId: 9 });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Sync Courses' }));
    await waitFor(() => expect(startSync).toHaveBeenCalledWith({ courseIds: [1, 2], syncBlocks: false }));
    expect(await screen.findByRole('button', { name: 'Syncing…' })).toBeInTheDocument();
  });
});

describe('CourseSection', () => {
  it('the summary reloads with the page\'s refreshKey; no sync of its own', async () => {
    const { rerender } = render(
      <MemoryRouter>
        <CourseSection course={{ id: 1, course_name: 'Art', archived: 0 }} grades={[grade(1)]} flagsByAssignment={{}} studentUid="u1" scales={{}}
          rubrics={{ attachments: {}, palette: {} }} studentId={7} refreshKey={0} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(summary).toHaveBeenLastCalledWith(expect.objectContaining({ reloadKey: 0 })));
    rerender(
      <MemoryRouter>
        <CourseSection course={{ id: 1, course_name: 'Art', archived: 0 }} grades={[grade(1)]} flagsByAssignment={{}} studentUid="u1" scales={{}}
          rubrics={{ attachments: {}, palette: {} }} studentId={7} refreshKey={1} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(summary).toHaveBeenLastCalledWith(expect.objectContaining({ reloadKey: 1 })));
  });
});

describe('StudentPage: Sync Courses always offered', () => {
  it('a student with only archived courses: Sync Courses reads those, and nothing syncs in the background', async () => {
    getStudent.mockResolvedValue({ ...student, courses: [{ id: 3, course_name: 'Old', archived: 1, course_synced_at: null }], grades: [grade(3)] });
    startSync.mockResolvedValue({ runId: 9, state: 'queued', joined: false });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Sync Courses' }));
    await waitFor(() => expect(startSync).toHaveBeenCalledWith({ courseIds: [3], syncBlocks: false }));
    expect(ensureSync).not.toHaveBeenCalled();
  });

  it('a student with no grades yet still has Sync Courses', async () => {
    getStudent.mockResolvedValue({ ...student, grades: [] });
    renderPage();
    expect(await screen.findByRole('button', { name: 'Sync Courses' })).toBeInTheDocument();
  });
});
