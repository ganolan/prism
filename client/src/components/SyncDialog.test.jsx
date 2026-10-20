import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import SyncDialog from './SyncDialog.jsx';
import * as api from '../services/api.js';
import { signInDeps } from '../lib/signIn.js';

vi.mock('../services/api.js');

const SUMMARY = { seq: 2, type: 'summary', schoology: { records: 5 }, mastery: [], elapsedMs: 1000 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getCourses).mockResolvedValue([{ id: 1, course_name: 'Biology 9', hidden: 0, archived: 0 }]);
  vi.mocked(api.getMasteryLoginStatus).mockResolvedValue({ loggedIn: true });
  vi.mocked(api.getSyncMetrics).mockResolvedValue(null);
  vi.mocked(api.getTriageCalendar).mockResolvedValue({ source: 'powerschool', totalSchoolDays: 120, syncedAt: new Date().toISOString() });
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

async function clickStart() {
  await waitFor(() => screen.getByRole('button', { name: /sync courses/i }));
  fireEvent.click(screen.getByRole('button', { name: /sync courses/i }));
}

describe('SyncDialog (the sync queue)', () => {
  it('loads courses and shows the course list', async () => {
    render(<SyncDialog onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Each ticked course gets everything/)).toBeInTheDocument());
    expect(screen.getByLabelText('Biology 9')).toBeInTheDocument();
  });

  it('Sync Courses queues the ticked courses and follows the run to the end', async () => {
    pollScript([done()]);
    const onSyncComplete = vi.fn();
    render(<SyncDialog onClose={() => {}} onSyncComplete={onSyncComplete} pollMs={1} />);
    await clickStart();
    await waitFor(() => expect(screen.getByText('Sync complete')).toBeInTheDocument());
    expect(api.startSync).toHaveBeenCalledWith(expect.objectContaining({ courseIds: [1] }));
    expect(api.startSync.mock.calls[0][0].masteryCourseIds).toBeUndefined(); // mastery for every course read
    expect(api.getSyncRunEvents).toHaveBeenCalledWith(9, 0);
    expect(onSyncComplete).toHaveBeenCalledTimes(1);
  });

  it('a queued run says it is waiting its turn', async () => {
    pollScript([{ status: 'queued', finished: false, events: [] }]);
    render(<SyncDialog onClose={() => {}} pollMs={5} />);
    await clickStart();
    expect(await screen.findByText(/Waiting for the running sync to finish/)).toBeInTheDocument();
  });

  it('a held run asks for the sign-in; nothing ran', async () => {
    pollScript([{ status: 'held', finished: false, events: [] }]);
    const go = vi.spyOn(signInDeps, 'go').mockImplementation(() => {});
    render(<SyncDialog onClose={() => {}} pollMs={1} />);
    await clickStart();
    expect(await screen.findByText('Waiting for a Schoology sign-in')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Log in to Schoology' }));
    expect(go).toHaveBeenCalledWith('/settings#schoology-signin');
    go.mockRestore();
  });

  it('review: a held run keeps being followed, and runs on after a sign-in elsewhere', async () => {
    pollScript([{ status: 'held', finished: false, events: [] }, { status: 'running', finished: false, events: [] }, done()]);
    render(<SyncDialog onClose={() => {}} pollMs={2} />);
    await clickStart();
    await screen.findByText('Waiting for a Schoology sign-in'); // shown while held (the next poll moves on)
    await waitFor(() => expect(screen.getByText('Sync complete')).toBeInTheDocument());
  });

  it('Sync Course (presetCourse) queues that one course at once, PowerSchool off', async () => {
    pollScript([done()]);
    render(<SyncDialog presetCourse={{ id: 5, name: 'AP CSP' }} onClose={() => {}} pollMs={1} />);
    await waitFor(() => expect(api.startSync).toHaveBeenCalledWith({ courseIds: [5], syncBlocks: false }));
    expect(api.getCourses).not.toHaveBeenCalled();
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
    render(<SyncDialog onClose={() => {}} pollMs={5} />);
    await clickStart();
    expect(await screen.findByText(/already queued/)).toBeInTheDocument();
  });

  it('polls from the last seq it saw', async () => {
    pollScript([
      { status: 'running', finished: false, events: [{ seq: 1, type: 'log', message: 'Fetching sections' }] },
      done([{ seq: 2, type: 'summary', schoology: { records: 2 }, mastery: [], elapsedMs: 1 }]),
    ]);
    render(<SyncDialog onClose={() => {}} pollMs={1} />);
    await clickStart();
    await waitFor(() => expect(screen.getByText('Sync complete')).toBeInTheDocument());
    expect(screen.getByText('Fetching sections')).toBeInTheDocument();
    expect(api.getSyncRunEvents).toHaveBeenNthCalledWith(2, 9, 1);
  });

  it('an interrupted run (server restarted) ends as a failure', async () => {
    pollScript([{ status: 'interrupted', finished: true, events: [] }]);
    render(<SyncDialog onClose={() => {}} pollMs={1} />);
    await clickStart();
    await waitFor(() => expect(screen.getByText('Sync failed')).toBeInTheDocument());
    expect(screen.getByText(/interrupted/i)).toBeInTheDocument();
  });

  it('a request that fails outright says the sync did not start, and refreshes nothing', async () => {
    api.startSync.mockRejectedValue(new Error('Prism is restarting'));
    const onSyncComplete = vi.fn();
    render(<SyncDialog onClose={() => {}} onSyncComplete={onSyncComplete} />);
    await clickStart();
    expect(await screen.findByText(/The sync didn't start: Prism is restarting/)).toBeInTheDocument();
    expect(onSyncComplete).not.toHaveBeenCalled();
  });

  it('unreachable for long enough: the neutral stalled state, and Try again resumes', async () => {
    let reachable = false;
    vi.mocked(api.getSyncRunEvents).mockImplementation(async () => {
      if (!reachable) throw new TypeError('Failed to fetch');
      return done();
    });
    render(<SyncDialog onClose={() => {}} pollMs={2} giveUpMs={10} />);
    await clickStart();
    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));
    reachable = true;
    await waitFor(() => expect(screen.getByText('Sync complete')).toBeInTheDocument());
  });

  it('a mastery-only retry asks for skipSchoology on the failed course', async () => {
    pollScript([done([{ seq: 1, phase: 'mastery', courseId: 1, courseName: 'Biology 9', status: 'error', message: 'boom' }, SUMMARY])]);
    render(<SyncDialog onClose={() => {}} pollMs={1} />);
    await clickStart();
    const retry = await screen.findByRole('button', { name: /retry/i });
    fireEvent.click(retry);
    await waitFor(() => expect(api.startSync).toHaveBeenLastCalledWith({ masteryCourseIds: [1], skipSchoology: true, syncBlocks: false }));
  });
});

describe('SyncDialog — Schoology connection status', () => {
  it('shows the live status beside the login option; the course load never waits on the live check', async () => {
    vi.mocked(api.getMasteryLoginStatus).mockImplementation(async ({ check = true } = {}) => (
      check ? { loggedIn: true, live: 'connected', checkedAt: '2026-10-03T06:05:00Z' } : { loggedIn: true, live: null, checkedAt: null }
    ));
    render(<SyncDialog onClose={() => {}} />);
    expect(await screen.findByText(/^Connected · checked/)).toBeInTheDocument();
    expect(api.getMasteryLoginStatus).toHaveBeenCalledWith({ check: false });
  });

  it('an expired session offers the login; the sync waits for it', async () => {
    vi.mocked(api.getMasteryLoginStatus).mockImplementation(async ({ check = true } = {}) => (
      check ? { loggedIn: true, live: 'expired', checkedAt: null } : { loggedIn: true, live: null, checkedAt: null }
    ));
    const go = vi.spyOn(signInDeps, 'go').mockImplementation(() => {});
    render(<SyncDialog onClose={() => {}} />);
    expect(await screen.findByText(/waits for you to log in/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Log in to Schoology' }));
    expect(go).toHaveBeenCalledWith('/settings#schoology-signin');
    go.mockRestore();
  });
});
