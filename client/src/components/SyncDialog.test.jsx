import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import SyncDialog from './SyncDialog.jsx';
import * as api from '../services/api.js';

vi.mock('../services/api.js');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getCourses).mockResolvedValue([
    { id: 1, course_name: 'Biology 9', hidden: 0, archived: 0 },
  ]);
  vi.mocked(api.getMasteryLoginStatus).mockResolvedValue({ loggedIn: true });
  vi.mocked(api.getSyncMetrics).mockResolvedValue(null);
  vi.mocked(api.getTriageCalendar).mockResolvedValue({
    source: 'powerschool', totalSchoolDays: 120, syncedAt: new Date().toISOString(),
  });
  vi.mocked(api.getCurrentSync).mockResolvedValue({ running: false, runId: null });
  vi.mocked(api.getSyncRunEvents).mockReset();
});

// A scripted poll endpoint: each call returns the next response.
function pollScript(responses) {
  const queue = [...responses];
  vi.mocked(api.getSyncRunEvents).mockImplementation(async () => (queue.length > 1 ? queue.shift() : queue[0]));
}

async function clickStart() {
  await waitFor(() => screen.getByRole('button', { name: /start sync/i }));
  fireEvent.click(screen.getByRole('button', { name: /start sync/i }));
}

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
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
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

  describe('surviving a dropped connection', () => {
    it('stream error after the runId: no error, polls the run from the last seq, then completes', async () => {
      vi.mocked(api.runSync).mockImplementation(async (opts, onEvent) => {
        onEvent({ type: 'run', runId: 7 });
        onEvent({ phase: 'schoology', status: 'running', seq: 1 });
        onEvent({ type: 'log', message: 'Fetching sections', seq: 2 });
        throw new TypeError('Load failed');
      });
      pollScript([
        { status: 'running', finished: false, events: [{ seq: 3, type: 'log', message: 'Fetching grades' }] },
        { status: 'completed', finished: true, events: [
          { seq: 4, phase: 'schoology', status: 'done', records: 12 },
          { seq: 5, type: 'summary', schoology: { records: 12 }, mastery: [], elapsedMs: 9000 },
        ] },
      ]);
      const onSyncComplete = vi.fn();
      render(<SyncDialog onClose={() => {}} onSyncComplete={onSyncComplete} pollMs={1} />);
      await clickStart();
      await waitFor(() => expect(screen.getByText('Sync complete')).toBeInTheDocument());
      expect(screen.queryByText(/Load failed/)).not.toBeInTheDocument();
      expect(screen.getByText('Fetching sections')).toBeInTheDocument();
      expect(screen.getByText('Fetching grades')).toBeInTheDocument();
      expect(screen.getByText('12 records')).toBeInTheDocument();
      expect(api.getSyncRunEvents).toHaveBeenNthCalledWith(1, 7, 2);
      expect(api.getSyncRunEvents).toHaveBeenNthCalledWith(2, 7, 3);
      expect(onSyncComplete).toHaveBeenCalledTimes(1);
    });

    it('shows the muted "connection lost" notice while it follows the run', async () => {
      vi.mocked(api.runSync).mockImplementation(async (opts, onEvent) => {
        onEvent({ type: 'run', runId: 7 });
        throw new TypeError('Load failed');
      });
      pollScript([{ status: 'running', finished: false, events: [] }]);
      render(<SyncDialog onClose={() => {}} pollMs={1} />);
      await clickStart();
      expect(await screen.findByText(/Connection lost — still syncing on the server/)).toBeInTheDocument();
      expect(screen.getByText('Syncing…')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
    });

    it('a stream that ends without a summary is followed to the end too', async () => {
      vi.mocked(api.runSync).mockImplementation(async (opts, onEvent) => {
        onEvent({ type: 'run', runId: 3 });
        onEvent({ phase: 'schoology', status: 'running', seq: 1 });
      });
      pollScript([{ status: 'completed', finished: true, events: [
        { seq: 2, phase: 'schoology', status: 'done', records: 4 },
        { seq: 3, type: 'summary', schoology: { records: 4 }, mastery: [], elapsedMs: 1 },
      ] }]);
      render(<SyncDialog onClose={() => {}} pollMs={1} />);
      await clickStart();
      await waitFor(() => expect(screen.getByText('Sync complete')).toBeInTheDocument());
      expect(api.getSyncRunEvents).toHaveBeenCalledWith(3, 1);
    });

    it('an interrupted run (server restarted) ends as a failure', async () => {
      vi.mocked(api.runSync).mockImplementation(async (opts, onEvent) => {
        onEvent({ type: 'run', runId: 7 });
        throw new TypeError('Load failed');
      });
      pollScript([{ status: 'interrupted', finished: true, events: [] }]);
      render(<SyncDialog onClose={() => {}} pollMs={1} />);
      await clickStart();
      await waitFor(() => expect(screen.getByText('Sync failed')).toBeInTheDocument());
      expect(screen.getByText(/interrupted/i)).toBeInTheDocument();
    });

    it('a drop before any runId joins the running sync if there is one', async () => {
      vi.mocked(api.runSync).mockRejectedValue(new TypeError('Load failed'));
      vi.mocked(api.getCurrentSync)
        .mockResolvedValueOnce({ running: false, runId: null }) // dialog open
        .mockResolvedValueOnce({ running: true, runId: 11 }); // after the drop
      pollScript([{ status: 'completed', finished: true, events: [
        { seq: 1, phase: 'schoology', status: 'done', records: 2 },
        { seq: 2, type: 'summary', schoology: { records: 2 }, mastery: [], elapsedMs: 1 },
      ] }]);
      render(<SyncDialog onClose={() => {}} pollMs={1} />);
      await clickStart();
      await waitFor(() => expect(screen.getByText('Sync complete')).toBeInTheDocument());
      expect(api.getSyncRunEvents).toHaveBeenCalledWith(11, 0);
    });

    it('409: joins the running sync and shows its earlier events', async () => {
      const conflict = Object.assign(new Error('A sync is already running.'), { status: 409, runId: 21 });
      vi.mocked(api.runSync).mockRejectedValue(conflict);
      let finishRun;
      const gate = new Promise((r) => { finishRun = r; });
      let calls = 0;
      vi.mocked(api.getSyncRunEvents).mockImplementation(async () => {
        if (calls++ === 0) {
          return { status: 'running', finished: false, events: [
            { seq: 1, phase: 'schoology', status: 'running' },
            { seq: 2, type: 'log', message: 'Earlier line from the first device' },
          ] };
        }
        await gate;
        return { status: 'completed', finished: true, events: [
          { seq: 3, phase: 'schoology', status: 'done', records: 8 },
          { seq: 4, type: 'summary', schoology: { records: 8 }, mastery: [], elapsedMs: 1 },
        ] };
      });
      render(<SyncDialog onClose={() => {}} pollMs={1} />);
      await clickStart();
      expect(await screen.findByText(/A sync is already running — showing its progress/)).toBeInTheDocument();
      expect(await screen.findByText('Earlier line from the first device')).toBeInTheDocument();
      finishRun();
      await waitFor(() => expect(screen.getByText('Sync complete')).toBeInTheDocument());
      expect(api.getSyncRunEvents).toHaveBeenNthCalledWith(1, 21, 0);
      expect(screen.queryByText('Sync failed')).not.toBeInTheDocument();
    });

    it('opening the dialog while a sync runs goes straight to the joined view', async () => {
      vi.mocked(api.getCurrentSync).mockResolvedValue({ running: true, runId: 5 });
      pollScript([
        { status: 'running', finished: false, events: [
          { seq: 1, phase: 'schoology', status: 'running' },
          { seq: 2, type: 'log', message: 'Already under way' },
        ] },
      ]);
      render(<SyncDialog onClose={() => {}} pollMs={1} />);
      expect(await screen.findByText('Already under way')).toBeInTheDocument();
      expect(screen.getByText(/A sync is already running — showing its progress/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /start sync/i })).not.toBeInTheDocument();
      expect(api.runSync).not.toHaveBeenCalled();
    });

    it('returning to the page while streaming switches to polling (stream may be silently dead)', async () => {
      let signal;
      vi.mocked(api.runSync).mockImplementation((opts, onEvent, o) => {
        signal = o?.signal;
        onEvent({ type: 'run', runId: 9 });
        onEvent({ phase: 'schoology', status: 'running', seq: 1 });
        // A hung stream: never resolves until aborted.
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      });
      pollScript([{ status: 'completed', finished: true, events: [
        { seq: 2, phase: 'schoology', status: 'done', records: 3 },
        { seq: 3, type: 'summary', schoology: { records: 3 }, mastery: [], elapsedMs: 1 },
      ] }]);
      render(<SyncDialog onClose={() => {}} pollMs={1} />);
      await clickStart();
      await waitFor(() => expect(signal).toBeDefined());
      document.dispatchEvent(new Event('visibilitychange'));
      await waitFor(() => expect(screen.getByText('Sync complete')).toBeInTheDocument());
      expect(signal.aborted).toBe(true);
      expect(api.getSyncRunEvents).toHaveBeenCalledWith(9, 1);
      expect(screen.queryByText(/aborted/)).not.toBeInTheDocument();
    });

    it('gives up with a pointer to Settings after repeated poll failures', async () => {
      vi.mocked(api.runSync).mockImplementation(async (opts, onEvent) => {
        onEvent({ type: 'run', runId: 7 });
        throw new TypeError('Load failed');
      });
      vi.mocked(api.getSyncRunEvents).mockRejectedValue(new Error('offline'));
      render(<SyncDialog onClose={() => {}} pollMs={1} />);
      await clickStart();
      await waitFor(() => expect(screen.getByText('Sync failed')).toBeInTheDocument());
      expect(screen.getByText(/Recent syncs/)).toBeInTheDocument();
    });
  });
});
