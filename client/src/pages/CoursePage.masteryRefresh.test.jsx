// #52/#108: the course page reads its mastery, submissions and scores from Schoology after it loads, and
// reloads what changed. #58: a prominent "Synced …" (course_synced_at) beside Sync Course, and one
// "Checked for new work …" line for those background reads.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import CoursePage from './CoursePage.jsx';
import * as api from '../services/api.js';

vi.mock('../services/api.js');

const OLD = '2026-10-18T19:02:00.000Z';
const NEW = '2026-10-19T06:00:00.000Z';
const SYNCED = new Date().toISOString();
const mastery = (at) => ({ categories: [], topics: [], scores: [], rollups: [], alignments: [], masterySyncedAt: at });

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  vi.mocked(api.getCourse).mockResolvedValue({ id: 5, course_name: 'AP CSP', archived: 0, course_synced_at: SYNCED });
  vi.mocked(api.getCourseStudents).mockResolvedValue([]);
  vi.mocked(api.getGradebook).mockResolvedValue({ assignments: [], folders: [], students: [], grades: {} });
  vi.mocked(api.getTriage).mockResolvedValue(null);
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

const renderPage = () => render(
  <MemoryRouter initialEntries={['/course/5']}>
    <Routes><Route path="/course/:id" element={<CoursePage />} /></Routes>
  </MemoryRouter>,
);
const check = () => screen.getByText(/new work/);

describe('CoursePage background reads (#52, #108)', () => {
  it('after loading, refreshes mastery and reloads the levels when it was read', async () => {
    vi.mocked(api.getMasteryForCourse).mockResolvedValueOnce(mastery(OLD)).mockResolvedValue(mastery(NEW));
    vi.mocked(api.refreshMasteryForCourse).mockResolvedValue({ refreshed: true, syncedAt: NEW });
    renderPage();
    await waitFor(() => expect(api.refreshMasteryForCourse).toHaveBeenCalledWith('5'));
    await waitFor(() => expect(api.getMasteryForCourse).toHaveBeenCalledTimes(2));
    expect(api.getGradebook).toHaveBeenCalledTimes(2); // its "aligned" flags can change too
  });

  it('reads the course\'s tasks once and reloads the gradebook when it read some', async () => {
    vi.mocked(api.getMasteryForCourse).mockResolvedValue(mastery(OLD));
    vi.mocked(api.refreshMasteryForCourse).mockResolvedValue({ refreshed: false, syncedAt: OLD });
    vi.mocked(api.refreshCourse).mockResolvedValue({ refreshed: 3, readAt: NEW, syncedAt: NEW, failed: [] });
    renderPage();
    await waitFor(() => expect(api.refreshCourse).toHaveBeenCalledWith('5'));
    await waitFor(() => expect(api.getGradebook).toHaveBeenCalledTimes(2));
    expect(api.refreshCourse).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(check().textContent).toMatch(/^Checked for new work at /));
  });

  it('a failed check says so and offers the sign-in', async () => {
    vi.mocked(api.getMasteryForCourse).mockResolvedValue(mastery(OLD));
    vi.mocked(api.refreshMasteryForCourse).mockResolvedValue({ refreshed: false, syncedAt: OLD, error: 'Log in to Schoology in Settings', signIn: true });
    vi.mocked(api.refreshCourse).mockResolvedValue({ refreshed: 0, readAt: NEW, syncedAt: NEW, failed: [] });
    renderPage();
    await waitFor(() => expect(check().textContent).toMatch(/^Could not check Schoology for new work\./));
    expect(screen.getByRole('button', { name: 'Log in to Schoology' })).toBeInTheDocument();
  });

  it('an archived course is not read', async () => {
    vi.mocked(api.getCourse).mockResolvedValue({ id: 5, course_name: 'AP CSP', archived: 1, course_synced_at: SYNCED });
    vi.mocked(api.getMasteryForCourse).mockResolvedValue(mastery(OLD));
    renderPage();
    await screen.findByText(/^Synced /);
    expect(api.refreshMasteryForCourse).not.toHaveBeenCalled();
    expect(api.refreshCourse).not.toHaveBeenCalled();
  });
});

describe('CoursePage Sync Course (#58)', () => {
  it('shows when the course was last synced, prominently', async () => {
    vi.mocked(api.getMasteryForCourse).mockResolvedValue(mastery(OLD));
    renderPage();
    expect(await screen.findByText(/^Synced \d\d:\d\d today$/)).toBeInTheDocument();
  });

  it('Sync Course syncs this course, everything, through the sync dialog', async () => {
    vi.mocked(api.getMasteryForCourse).mockResolvedValue(mastery(OLD));
    vi.mocked(api.getCurrentSync).mockResolvedValue({ running: false, runId: null, courseIds: null });
    vi.mocked(api.getMasteryLoginStatus).mockResolvedValue({ loggedIn: true });
    vi.mocked(api.getCourses).mockResolvedValue([]);
    vi.mocked(api.runSync).mockResolvedValue(undefined);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Sync Course' }));
    await waitFor(() => expect(api.runSync).toHaveBeenCalled());
    expect(api.runSync.mock.calls[0][0]).toMatchObject({ courseIds: [5], masteryCourseIds: [5], syncBlocks: false });
  });
});
