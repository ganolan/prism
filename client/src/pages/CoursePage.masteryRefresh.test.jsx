// Background sync: the course page asks the queue to sync its course after it loads (nothing when synced
// in the last 10 minutes), shows one "Synced …" (course_synced_at) with a chip while it syncs, and
// reloads when the sync ends. Sync Course queues a full sync now.
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
  vi.mocked(api.getMasteryForCourse).mockResolvedValue(mastery(OLD));
  vi.mocked(api.ensureSync).mockResolvedValue({ state: 'fresh' });
  vi.mocked(api.getSyncStatus).mockResolvedValue({ nightlyData: { readAt: SYNCED, nightly: true }, syncing: false });
  vi.mocked(api.getCurrentSync).mockResolvedValue({ running: null, runId: null, queued: [], held: [] });
  vi.mocked(api.startSync).mockResolvedValue({ runId: 9, state: 'queued', joined: false });
  vi.mocked(api.getSyncRunEvents).mockResolvedValue({ status: 'running', finished: false, events: [] });
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

describe('CoursePage background sync', () => {
  it('asks the queue for this course after loading; no partial reads', async () => {
    renderPage();
    await waitFor(() => expect(api.ensureSync).toHaveBeenCalledWith({ kind: 'courses', courseIds: [5] }));
    expect(api.refreshMasteryForCourse).toBeUndefined(); // the partial page read is gone
    expect(screen.queryByText(/new work/)).toBeNull();
    expect(await screen.findByText(/^Synced \d\d:\d\d today$/)).toBeInTheDocument();
  });

  it('a help "?" sits beside the Synced time and names Sync Course', async () => {
    renderPage();
    const dot = await screen.findByRole('img', { name: /Press Sync Course only if you changed something in Schoology just now\./ });
    expect(dot).toHaveAttribute('aria-label', expect.stringContaining('Blocks, calendar and alerts: refreshed every night.'));
  });

  it('final review #8: the "?" is there when the sync status cannot be read (nightly taken as off)', async () => {
    vi.mocked(api.getSyncStatus).mockRejectedValue(new Error('Prism is restarting'));
    renderPage();
    const dot = await screen.findByRole('img', { name: /Press Sync Course only if you changed something in Schoology just now\./ });
    expect(dot).toHaveAttribute('aria-label', expect.stringContaining('refreshed when you press Sync Courses on the dashboard.'));
  });

  it('an archived course: the "?" says past courses are not refreshed, and how to read it again', async () => {
    vi.mocked(api.getCourse).mockResolvedValue({ id: 5, course_name: 'AP CSP', archived: 1, course_synced_at: SYNCED });
    renderPage();
    expect(await screen.findByRole('img', {
      name: 'Prism does not refresh past courses automatically. Press Sync Course to read it again.',
    })).toBeInTheDocument();
  });

  it('while it syncs: the chip; clicking it opens the progress on that run; when it ends the page reloads', async () => {
    vi.mocked(api.ensureSync).mockResolvedValue({ state: 'running', runId: 4 });
    let running = true;
    vi.mocked(api.getCurrentSync).mockImplementation(async () => (running
      ? { running: { runId: 4 }, runId: 4, queued: [], held: [] }
      : { running: null, runId: null, queued: [], held: [] }));
    vi.mocked(api.getSyncRun).mockResolvedValue({ id: 4, status: 'completed' });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Syncing…' }));
    await waitFor(() => expect(api.getSyncRunEvents).toHaveBeenCalledWith(4, 0));
    const before = vi.mocked(api.getGradebook).mock.calls.length;
    running = false;
    await waitFor(() => expect(vi.mocked(api.getGradebook).mock.calls.length).toBeGreaterThan(before), { timeout: 4000 });
  });

  it('an archived course: no background sync, never amber', async () => {
    vi.mocked(api.getCourse).mockResolvedValue({ id: 5, course_name: 'AP CSP', archived: 1, course_synced_at: OLD });
    const { container } = renderPage();
    await screen.findByText(/^Synced /);
    expect(api.ensureSync).not.toHaveBeenCalled();
    expect(container.querySelector('.sync-status')).not.toHaveClass('sync-status--stale');
  });

  it('Sync Course queues a full sync of this course and shows its progress', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Sync Course' }));
    await waitFor(() => expect(api.startSync).toHaveBeenCalledWith({ courseIds: [5], syncBlocks: false }));
  });

  it('review: an open Sync Course dialog does not fake "Syncing…"; the chip follows the run it started', async () => {
    let runs = 0;
    vi.mocked(api.getCurrentSync).mockImplementation(async () => (runs
      ? { running: { runId: 9 }, runId: 9, queued: [], held: [] }
      : { running: null, runId: null, queued: [], held: [] }));
    vi.mocked(api.startSync).mockImplementation(async () => { runs += 1; return { runId: 9, state: 'queued', joined: false }; });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Sync Course' }));
    await waitFor(() => expect(api.startSync).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(await screen.findByRole('button', { name: 'Syncing…' })).toBeInTheDocument();
  });
});
