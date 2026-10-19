// #52: the course page shows when its mastery was read, refreshes it from Schoology after it loads,
// and reloads the levels when Schoology was read.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import CoursePage from './CoursePage.jsx';
import * as api from '../services/api.js';

vi.mock('../services/api.js');

const OLD = '2026-10-18T19:02:00.000Z';
const NEW = '2026-10-19T06:00:00.000Z';
const mastery = (at) => ({ categories: [], topics: [], scores: [], rollups: [], alignments: [], masterySyncedAt: at });

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  vi.mocked(api.getCourse).mockResolvedValue({ id: 5, course_name: 'AP CSP', archived: 0 });
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
const freshness = () => screen.getByText(/Mastery levels|Could not refresh mastery/);

describe('CoursePage mastery refresh (#52)', () => {
  it('after loading, refreshes from Schoology and reloads the levels when it was read', async () => {
    vi.mocked(api.getMasteryForCourse).mockResolvedValueOnce(mastery(OLD)).mockResolvedValue(mastery(NEW));
    vi.mocked(api.refreshMasteryForCourse).mockResolvedValue({ refreshed: true, syncedAt: NEW });
    renderPage();
    await waitFor(() => expect(api.refreshMasteryForCourse).toHaveBeenCalledWith('5'));
    await waitFor(() => expect(api.getMasteryForCourse).toHaveBeenCalledTimes(2));
    expect(api.getGradebook).toHaveBeenCalledTimes(2); // its "aligned" flags can change too
    await waitFor(() => expect(freshness().textContent).toMatch(/^Mastery levels read from Schoology at /));
  });

  it('fresh data is not reloaded; a failed refresh says so and offers the sign-in', async () => {
    vi.mocked(api.getMasteryForCourse).mockResolvedValue(mastery(OLD));
    vi.mocked(api.refreshMasteryForCourse).mockResolvedValue({ refreshed: false, syncedAt: OLD, error: 'Log in to Schoology in Settings', signIn: true });
    renderPage();
    await waitFor(() => expect(freshness().textContent).toMatch(/^Could not refresh mastery levels from Schoology\. Showing levels read at /));
    expect(screen.getByRole('button', { name: 'Log in to Schoology' })).toBeInTheDocument();
    expect(api.getMasteryForCourse).toHaveBeenCalledTimes(1);
  });

  it('an archived course is not refreshed', async () => {
    vi.mocked(api.getCourse).mockResolvedValue({ id: 5, course_name: 'AP CSP', archived: 1 });
    vi.mocked(api.getMasteryForCourse).mockResolvedValue(mastery(OLD));
    renderPage();
    await waitFor(() => expect(freshness().textContent).toMatch(/^Mastery levels read from Schoology at /));
    expect(api.refreshMasteryForCourse).not.toHaveBeenCalled();
  });

  it('Sync Mastery reloads the levels it read', async () => {
    vi.mocked(api.getMasteryForCourse).mockResolvedValue(mastery(OLD));
    vi.mocked(api.refreshMasteryForCourse).mockResolvedValue({ refreshed: false, syncedAt: OLD });
    vi.mocked(api.triggerMasterySync).mockResolvedValue({ categoriesCount: 1, topicsCount: 2, scoresCount: 3, syncedAt: NEW });
    renderPage();
    await waitFor(() => expect(api.refreshMasteryForCourse).toHaveBeenCalled());
    const before = vi.mocked(api.getMasteryForCourse).mock.calls.length;
    fireEvent.click(await screen.findByRole('button', { name: 'Sync Mastery' }));
    await waitFor(() => expect(vi.mocked(api.getMasteryForCourse).mock.calls.length).toBe(before + 1));
  });
});

describe('CoursePage submissions and scores read (#108)', () => {
  it('reads the course once after loading and reloads the gradebook when it read some', async () => {
    vi.mocked(api.getMasteryForCourse).mockResolvedValue(mastery(OLD));
    vi.mocked(api.refreshMasteryForCourse).mockResolvedValue({ refreshed: false, syncedAt: OLD });
    vi.mocked(api.refreshCourse).mockResolvedValue({ refreshed: 3, readAt: NEW, syncedAt: NEW, failed: [] });
    renderPage();
    await waitFor(() => expect(api.refreshCourse).toHaveBeenCalledWith('5'));
    await waitFor(() => expect(api.getGradebook).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/^Submissions and scores read from Schoology at /)).toBeInTheDocument();
    expect(api.refreshCourse).toHaveBeenCalledTimes(1);
  });

  it('an archived course is not read', async () => {
    vi.mocked(api.getCourse).mockResolvedValue({ id: 5, course_name: 'AP CSP', archived: 1 });
    vi.mocked(api.getMasteryForCourse).mockResolvedValue(mastery(OLD));
    renderPage();
    await waitFor(() => expect(freshness().textContent).toMatch(/^Mastery levels read from Schoology at /));
    expect(api.refreshCourse).not.toHaveBeenCalled();
  });
});
