import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import SyncDialog from './SyncDialog.jsx';
import * as api from '../services/api.js';
import { signInDeps } from '../lib/signIn.js';

vi.mock('../services/api.js');

const SUMMARY = { seq: 2, type: 'summary', schoology: { records: 5 }, mastery: [], elapsedMs: 1000 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getSyncMetrics).mockResolvedValue(null);
  vi.mocked(api.startSync).mockResolvedValue({ runId: 9, state: 'queued', joined: false });
  vi.mocked(api.getSyncRunEvents).mockReset();
});

// jsdom is always "visible"; let a test hide the page.
let visibility = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
Object.defineProperty(document, 'hidden', { configurable: true, get: () => visibility === 'hidden' });
afterEach(() => { visibility = 'visible'; });

// A scripted poll endpoint: each call returns the next response (the last one repeats).
function pollScript(responses) {
  const queue = [...responses];
  vi.mocked(api.getSyncRunEvents).mockImplementation(async () => (queue.length > 1 ? queue.shift() : queue[0]));
}
const done = (events = [{ seq: 1, phase: 'schoology', status: 'done', records: 5 }, SUMMARY]) => ({ status: 'completed', finished: true, events });

const EVERYTHING = { everything: true };

describe('SyncDialog (the sync queue)', () => {
  it('a request (Sync Courses) is posted as it is on mount, and the run is followed to the end', async () => {
    pollScript([done()]);
    const onSyncComplete = vi.fn();
    const onRun = vi.fn();
    render(<SyncDialog request={EVERYTHING} onClose={() => {}} onSyncComplete={onSyncComplete} onRun={onRun} pollMs={1} />);
    expect(screen.queryByText(/Loading courses/)).toBeNull(); // progress at once, no course list
    await waitFor(() => expect(screen.getByText('Sync complete')).toBeInTheDocument());
    expect(api.startSync).toHaveBeenCalledTimes(1);
    expect(api.startSync).toHaveBeenCalledWith({ everything: true });
    expect(onRun).toHaveBeenCalledWith(9);
    expect(api.getSyncRunEvents).toHaveBeenCalledWith(9, 0);
    expect(onSyncComplete).toHaveBeenCalledTimes(1);
  });

  it('a queued run says it is waiting its turn', async () => {
    pollScript([{ status: 'queued', finished: false, events: [] }]);
    render(<SyncDialog request={EVERYTHING} onClose={() => {}} pollMs={5} />);
    expect(await screen.findByText(/Waiting for the running sync to finish/)).toBeInTheDocument();
  });

  it('a held run asks for the sign-in; nothing ran', async () => {
    pollScript([{ status: 'held', finished: false, events: [] }]);
    const go = vi.spyOn(signInDeps, 'go').mockImplementation(() => {});
    render(<SyncDialog request={EVERYTHING} onClose={() => {}} pollMs={1} />);
    expect(await screen.findByText('Waiting for a Schoology sign-in')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Log in to Schoology' }));
    expect(go).toHaveBeenCalledWith('/settings#schoology-signin');
    go.mockRestore();
  });

  it('review: a held run keeps being followed, and runs on after a sign-in elsewhere', async () => {
    pollScript([{ status: 'held', finished: false, events: [] }, { status: 'running', finished: false, events: [] }, done()]);
    render(<SyncDialog request={EVERYTHING} onClose={() => {}} pollMs={2} />);
    await screen.findByText('Waiting for a Schoology sign-in'); // shown while held (the next poll moves on)
    await waitFor(() => expect(screen.getByText('Sync complete')).toBeInTheDocument());
  });

  it('Sync Course (presetCourse) queues that one course at once, PowerSchool off', async () => {
    pollScript([done()]);
    render(<SyncDialog presetCourse={{ id: 5, name: 'AP CSP' }} onClose={() => {}} pollMs={1} />);
    await waitFor(() => expect(api.startSync).toHaveBeenCalledWith({ courseIds: [5], syncBlocks: false }));
      });

  it('followRunId (a page chip) follows that run and starts nothing', async () => {
    pollScript([done()]);
    render(<SyncDialog followRunId={4} onClose={() => {}} pollMs={1} />);
    await waitFor(() => expect(screen.getByText('Sync complete')).toBeInTheDocument());
    expect(api.getSyncRunEvents).toHaveBeenCalledWith(4, 0);
    expect(api.startSync).not.toHaveBeenCalled();
  });

  it('a request the queue joined says so', async () => {
    api.startSync.mockResolvedValue({ runId: 3, state: 'queued', joined: true });
    pollScript([{ status: 'running', finished: false, events: [] }]);
    render(<SyncDialog request={EVERYTHING} onClose={() => {}} pollMs={5} />);
    expect(await screen.findByText(/already queued/)).toBeInTheDocument();
  });

  it('polls from the last seq it saw', async () => {
    pollScript([
      { status: 'running', finished: false, events: [{ seq: 1, type: 'log', message: 'Fetching sections' }] },
      done([{ seq: 2, type: 'summary', schoology: { records: 2 }, mastery: [], elapsedMs: 1 }]),
    ]);
    render(<SyncDialog request={EVERYTHING} onClose={() => {}} pollMs={1} />);
    await waitFor(() => expect(screen.getByText('Sync complete')).toBeInTheDocument());
    expect(screen.getByText('Fetching sections')).toBeInTheDocument();
    expect(api.getSyncRunEvents).toHaveBeenNthCalledWith(2, 9, 1);
  });

  it('an interrupted run (server restarted) ends as a failure', async () => {
    pollScript([{ status: 'interrupted', finished: true, events: [] }]);
    render(<SyncDialog request={EVERYTHING} onClose={() => {}} pollMs={1} />);
    await waitFor(() => expect(screen.getByText('Sync failed')).toBeInTheDocument());
    expect(screen.getByText(/interrupted/i)).toBeInTheDocument();
  });

  it('a request that fails outright says the sync did not start, and refreshes nothing', async () => {
    api.startSync.mockRejectedValue(new Error('Prism is restarting'));
    const onSyncComplete = vi.fn();
    render(<SyncDialog request={EVERYTHING} onClose={() => {}} onSyncComplete={onSyncComplete} />);
    expect(await screen.findByText(/The sync didn't start: Prism is restarting/)).toBeInTheDocument();
    expect(onSyncComplete).not.toHaveBeenCalled();
  });

  it('unreachable for long enough: the neutral stalled state, and Try again resumes', async () => {
    let reachable = false;
    vi.mocked(api.getSyncRunEvents).mockImplementation(async () => {
      if (!reachable) throw new TypeError('Failed to fetch');
      return done();
    });
    render(<SyncDialog request={EVERYTHING} onClose={() => {}} pollMs={2} giveUpMs={10} />);
    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));
    reachable = true;
    await waitFor(() => expect(screen.getByText('Sync complete')).toBeInTheDocument());
  });

  it('a mastery-only retry asks for skipSchoology on the failed course', async () => {
    pollScript([done([{ seq: 1, phase: 'mastery', courseId: 1, courseName: 'Biology 9', status: 'error', message: 'boom' }, SUMMARY])]);
    render(<SyncDialog request={EVERYTHING} onClose={() => {}} pollMs={1} />);
    const retry = await screen.findByRole('button', { name: /retry/i });
    fireEvent.click(retry);
    await waitFor(() => expect(api.startSync).toHaveBeenLastCalledWith({ masteryCourseIds: [1], skipSchoology: true, syncBlocks: false }));
  });
});
