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
    expect(within(log).getByText('Schoology data — 40 records')).toBeInTheDocument();
    const err = within(log).getByText('Mastery · Bio — Not logged in').closest('.sync-run-line');
    expect(err).toHaveClass('sync-run-line-error');
    const warn = within(log).getByText('[Bio] Warning: rollup fetch failed: 500').closest('.sync-run-line');
    expect(warn).toHaveClass('sync-run-line-warning');
    expect(within(log).getByText('Finished in 2m 30s')).toBeInTheDocument();
    // Collapses again.
    fireEvent.click(row);
    expect(screen.queryByRole('log')).not.toBeInTheDocument();
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
