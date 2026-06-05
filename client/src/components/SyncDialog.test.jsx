import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import SyncDialog from './SyncDialog.jsx';
import * as api from '../services/api.js';

vi.mock('../services/api.js');

beforeEach(() => {
  vi.mocked(api.getCourses).mockResolvedValue([
    { id: 1, course_name: 'Biology 9', hidden: 0, archived: 0 },
  ]);
  vi.mocked(api.getMasteryLoginStatus).mockResolvedValue({ loggedIn: true });
  vi.mocked(api.getSyncMetrics).mockResolvedValue(null);
});

describe('SyncDialog', () => {
  it('loads courses and shows the config step', async () => {
    render(<SyncDialog onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Step 1 · Schoology/)).toBeInTheDocument());
    expect(screen.getByLabelText('Biology 9')).toBeInTheDocument();
  });

  it('switches to the progress overlay when Start sync is clicked', async () => {
    vi.mocked(api.runSync).mockImplementation(async (opts, onEvent) => {
      onEvent({ phase: 'schoology', status: 'done', records: 5 });
      onEvent({ type: 'summary', schoology: { records: 5 }, mastery: [], elapsedMs: 1000 });
    });
    render(<SyncDialog onClose={() => {}} />);
    await waitFor(() => screen.getByRole('button', { name: /start sync/i }));
    fireEvent.click(screen.getByRole('button', { name: /start sync/i }));
    await waitFor(() => expect(screen.getByText(/Sync complete/)).toBeInTheDocument());
  });

  it('shows the running overlay before the sync completes', async () => {
    let finish;
    vi.mocked(api.runSync).mockImplementation((opts, onEvent) => {
      onEvent({ phase: 'schoology', status: 'running' });
      return new Promise((resolve) => {
        finish = () => {
          onEvent({ type: 'summary', schoology: { records: 1 }, mastery: [], elapsedMs: 1 });
          resolve();
        };
      });
    });
    render(<SyncDialog onClose={() => {}} />);
    await waitFor(() => screen.getByRole('button', { name: /start sync/i }));
    fireEvent.click(screen.getByRole('button', { name: /start sync/i }));
    await waitFor(() => expect(screen.getByText('Syncing…')).toBeInTheDocument());
    finish();
    await waitFor(() => expect(screen.getByText('Sync complete')).toBeInTheDocument());
  });

  it('retry re-runs the sync with skipSchoology for the failed course', async () => {
    vi.mocked(api.runSync).mockImplementation(async (opts, onEvent) => {
      if (opts.skipSchoology) {
        onEvent({ phase: 'mastery', courseId: 1, courseName: 'Biology 9', status: 'done', records: 4 });
        onEvent({ type: 'summary', schoology: null, mastery: [], elapsedMs: 1 });
      } else {
        onEvent({ phase: 'schoology', status: 'done', records: 5 });
        onEvent({ phase: 'mastery', courseId: 1, courseName: 'Biology 9', status: 'error', errorKind: 'other', message: 'boom' });
        onEvent({ type: 'summary', schoology: { records: 5 }, mastery: [], elapsedMs: 1 });
      }
    });
    render(<SyncDialog onClose={() => {}} />);
    await waitFor(() => screen.getByRole('button', { name: /start sync/i }));
    fireEvent.click(screen.getByRole('button', { name: /start sync/i }));
    await waitFor(() => expect(screen.getByText(/Sync finished with issues/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(screen.getByText('Sync complete')).toBeInTheDocument());
    expect(api.runSync).toHaveBeenLastCalledWith(
      expect.objectContaining({ skipSchoology: true, masteryCourseIds: [1] }),
      expect.any(Function),
    );
  });

  it('shows a failure heading when runSync throws', async () => {
    vi.mocked(api.runSync).mockRejectedValue(new Error('network down'));
    render(<SyncDialog onClose={() => {}} />);
    await waitFor(() => screen.getByRole('button', { name: /start sync/i }));
    fireEvent.click(screen.getByRole('button', { name: /start sync/i }));
    await waitFor(() => expect(screen.getByText('Sync failed')).toBeInTheDocument());
  });

  it('calls onSyncComplete after a sync run finishes so open pages can refresh', async () => {
    vi.mocked(api.runSync).mockImplementation(async (opts, onEvent) => {
      onEvent({ phase: 'schoology', status: 'done', records: 5 });
      onEvent({ type: 'summary', schoology: { records: 5 }, mastery: [], elapsedMs: 1000 });
    });
    const onSyncComplete = vi.fn();
    render(<SyncDialog onClose={() => {}} onSyncComplete={onSyncComplete} />);
    await waitFor(() => screen.getByRole('button', { name: /start sync/i }));
    fireEvent.click(screen.getByRole('button', { name: /start sync/i }));
    await waitFor(() => expect(screen.getByText('Sync complete')).toBeInTheDocument());
    expect(onSyncComplete).toHaveBeenCalledTimes(1);
  });

  it('does not call onSyncComplete when the sync request fails outright', async () => {
    vi.mocked(api.runSync).mockRejectedValue(new Error('network down'));
    const onSyncComplete = vi.fn();
    render(<SyncDialog onClose={() => {}} onSyncComplete={onSyncComplete} />);
    await waitFor(() => screen.getByRole('button', { name: /start sync/i }));
    fireEvent.click(screen.getByRole('button', { name: /start sync/i }));
    await waitFor(() => expect(screen.getByText('Sync failed')).toBeInTheDocument());
    expect(onSyncComplete).not.toHaveBeenCalled();
  });

  it('shows the abandoned banner when sync_metrics reports abandoned', async () => {
    vi.mocked(api.runSync).mockImplementation(async (opts, onEvent) => {
      onEvent({ phase: 'schoology', status: 'done', records: 5 });
      onEvent({ type: 'summary', schoology: { records: 5 }, mastery: [], elapsedMs: 1000 });
    });
    vi.mocked(api.getSyncMetrics).mockResolvedValue({
      id: 1, abandoned: 1, retries_failed: 0, failed_assignment_ids: [],
    });
    render(<SyncDialog onClose={() => {}} />);
    await waitFor(() => screen.getByRole('button', { name: /start sync/i }));
    fireEvent.click(screen.getByRole('button', { name: /start sync/i }));
    await waitFor(() => expect(screen.getByText(/abandoned/i)).toBeInTheDocument());
  });
});
