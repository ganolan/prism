import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import RecentSyncs from './RecentSyncs.jsx';
import * as api from '../services/api.js';

vi.mock('../services/api.js', () => ({
  getSyncRuns: vi.fn(),
  getSyncRun: vi.fn(),
}));

const RUNS = [
  { id: 3, started_at: '2026-10-01T09:00:00Z', finished_at: null, status: 'running', error_count: 0, warning_count: 0, options: { syncBlocks: true, masteryCourseIds: [] } },
  { id: 2, started_at: '2026-09-30T09:00:00Z', finished_at: '2026-09-30T09:02:30Z', status: 'completed_with_errors', error_count: 2, warning_count: 1, options: {} },
  { id: 1, started_at: '2026-09-29T09:00:00Z', finished_at: '2026-09-29T09:00:40Z', status: 'completed', error_count: 0, warning_count: 0, options: {} },
  { id: 0, started_at: '2026-09-28T09:00:00Z', finished_at: '2026-09-28T09:00:10Z', status: 'interrupted', error_count: 0, warning_count: 0, options: {} },
];

beforeEach(() => {
  vi.clearAllMocks();
  api.getSyncRuns.mockResolvedValue(RUNS);
  api.getSyncRun.mockResolvedValue({
    ...RUNS[1],
    events: [
      { seq: 1, at: '2026-09-30T09:00:01Z', phase: 'schoology', status: 'done', records: 40, level: null },
      { seq: 2, at: '2026-09-30T09:00:02Z', type: 'log', message: '[Bio] Warning: rollup fetch failed: 500', level: 'warning' },
      { seq: 3, at: '2026-09-30T09:01:00Z', phase: 'mastery', courseId: 1, courseName: 'Bio', status: 'error', message: 'Not logged in', level: 'error' },
      { seq: 4, at: '2026-09-30T09:02:30Z', type: 'summary', elapsedMs: 150000, level: null },
    ],
  });
});

describe('RecentSyncs', () => {
  it('lists runs with status badges, durations and counts', async () => {
    render(<RecentSyncs />);
    expect(await screen.findByText('Completed with 2 errors')).toBeInTheDocument();
    expect(screen.getByText('Running…')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('Interrupted')).toBeInTheDocument();
    expect(screen.getByText('2m 30s')).toBeInTheDocument();
    expect(screen.getByText('2 errors · 1 warning')).toBeInTheDocument();
    expect(screen.getByText('30/09/2026, ' + new Date('2026-09-30T09:00:00Z').toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))).toBeInTheDocument();
    expect(api.getSyncRuns).toHaveBeenCalledWith(30);
  });

  it('expanding a run shows its log with errors and warnings highlighted', async () => {
    render(<RecentSyncs />);
    const row = (await screen.findByText('Completed with 2 errors')).closest('button');
    expect(row).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(row);
    const log = await screen.findByRole('log');
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(api.getSyncRun).toHaveBeenCalledWith(2);
    expect(within(log).getByText('Schoology data: 40 records')).toBeInTheDocument();
    const err = within(log).getByText('Mastery · Bio: Not logged in').closest('.sync-run-line');
    expect(err).toHaveClass('sync-run-line-error');
    const warn = within(log).getByText('[Bio] Warning: rollup fetch failed: 500').closest('.sync-run-line');
    expect(warn).toHaveClass('sync-run-line-warning');
    expect(within(log).getByText('Finished in 2m 30s')).toBeInTheDocument();
    // Collapses again.
    fireEvent.click(row);
    expect(screen.queryByRole('log')).not.toBeInTheDocument();
  });

  describe('time per phase (#165)', () => {
    const TIMED_RUN = {
      ...RUNS[2],
      events: [
        { seq: 1, at: '2026-09-29T09:00:01Z', phase: 'schoology', status: 'running', level: null },
        { seq: 2, at: '2026-09-29T09:00:20Z', phase: 'schoology', status: 'done', records: 4, elapsedMs: 19000, level: null },
        { seq: 3, at: '2026-09-29T09:00:29Z', phase: 'blocks', status: 'done', records: 3, elapsedMs: 8500, level: null },
        { seq: 4, at: '2026-09-29T09:00:35Z', phase: 'mastery', courseId: 5, courseName: 'Course A', status: 'done', records: 7, elapsedMs: 6000, level: null },
        { seq: 5, at: '2026-09-29T09:00:39Z', phase: 'mastery', courseId: 6, courseName: 'Course B', status: 'error', message: 'Not logged in', elapsedMs: 4000, level: 'error' },
        { seq: 6, at: '2026-09-29T09:00:40Z', type: 'summary', elapsedMs: 40000, phaseMs: { schoology: 19000, blocks: 8500, alerts: null, mastery: 10000, comments: null, quizzes: null }, level: null },
      ],
    };

    async function expand(label) {
      fireEvent.click((await screen.findByText(label)).closest('button'));
      await screen.findByRole('log');
    }

    it('an expanded run lists each phase it timed, as the sync dialog does', async () => {
      api.getSyncRun.mockResolvedValue(TIMED_RUN);
      render(<RecentSyncs />);
      await expand('Completed');
      const list = await screen.findByRole('list', { name: 'Time per phase' });
      const lines = within(list).getAllByRole('listitem').map((li) => li.textContent);
      expect(lines).toEqual([
        'Schoology data19s',
        'PowerSchool blocks8.5s',
        'Mastery · Course A6.0s',
        'Mastery · Course B4.0s',
      ]);
      expect(document.getElementById('sync-run-log-1')).toContainElement(list);
    });

    it('shows no phase times for a run that never stored them (interrupted)', async () => {
      api.getSyncRun.mockResolvedValue({ ...RUNS[3], events: TIMED_RUN.events.slice(0, 3) });
      render(<RecentSyncs />);
      await expand('Interrupted');
      expect(screen.queryByRole('list', { name: 'Time per phase' })).not.toBeInTheDocument();
    });

    it('shows no phase times while a run is still going', async () => {
      api.getSyncRun.mockResolvedValue({ ...RUNS[0], events: TIMED_RUN.events.slice(0, 3) });
      render(<RecentSyncs refreshMs={60000} />);
      await expand('Running…');
      expect(screen.queryByRole('list', { name: 'Time per phase' })).not.toBeInTheDocument();
    });

    it('shows nothing extra for a run logged before phase times were kept', async () => {
      render(<RecentSyncs />);
      await expand('Completed with 2 errors');
      expect(screen.queryByRole('list', { name: 'Time per phase' })).not.toBeInTheDocument();
      expect(screen.queryByText('Time per phase')).not.toBeInTheDocument();
    });

    it('shows nothing for a run before #143 whose blocks phase alone was timed', async () => {
      api.getSyncRun.mockResolvedValue({
        ...RUNS[2],
        events: [
          { seq: 1, at: '2026-09-29T09:00:20Z', phase: 'schoology', status: 'done', records: 4, level: null },
          { seq: 2, at: '2026-09-29T09:00:29Z', phase: 'blocks', status: 'done', records: 3, elapsedMs: 9887, level: null },
          { seq: 3, at: '2026-09-29T09:00:40Z', type: 'summary', elapsedMs: 40000, level: null },
        ],
      });
      render(<RecentSyncs />);
      await expand('Completed');
      expect(screen.queryByRole('list', { name: 'Time per phase' })).not.toBeInTheDocument();
    });
  });

  it('shows an empty state when nothing has been recorded yet', async () => {
    api.getSyncRuns.mockResolvedValue([]);
    render(<RecentSyncs />);
    expect(await screen.findByText(/No syncs recorded yet/)).toBeInTheDocument();
  });

  it('the expand button controls the log region', async () => {
    render(<RecentSyncs />);
    const row = (await screen.findByText('Completed with 2 errors')).closest('button');
    fireEvent.click(row);
    const log = await screen.findByRole('log');
    const regionId = row.getAttribute('aria-controls');
    expect(regionId).toBeTruthy();
    expect(document.getElementById(regionId)).toContainElement(log);
  });

  it('Refresh reloads the list and an expanded log', async () => {
    render(<RecentSyncs />);
    fireEvent.click((await screen.findByText('Completed with 2 errors')).closest('button'));
    await screen.findByRole('log');
    expect(api.getSyncRun).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(api.getSyncRun).toHaveBeenCalledTimes(2));
    expect(api.getSyncRuns).toHaveBeenCalledTimes(2);
  });

  it('an expanded running log refreshes itself until the run finishes', async () => {
    const running = { ...RUNS[0], events: [{ seq: 1, at: '2026-10-01T09:00:01Z', type: 'log', message: 'Fetching sections', level: null }] };
    const finished = {
      ...RUNS[0], status: 'completed', finished_at: '2026-10-01T09:01:00Z',
      events: [...running.events, { seq: 2, at: '2026-10-01T09:01:00Z', type: 'summary', elapsedMs: 60000, level: null }],
    };
    api.getSyncRun.mockResolvedValueOnce(running).mockResolvedValueOnce(running).mockResolvedValue(finished);
    render(<RecentSyncs refreshMs={5} />);
    fireEvent.click((await screen.findByText('Running…')).closest('button'));
    expect(await screen.findByText('Finished in 1m 0s')).toBeInTheDocument();
    const calls = api.getSyncRun.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(3);
    // Finished → stops polling, and the list reloads to pick up the new status.
    await new Promise((r) => setTimeout(r, 40));
    expect(api.getSyncRun.mock.calls.length).toBe(calls);
    await waitFor(() => expect(api.getSyncRuns.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});
