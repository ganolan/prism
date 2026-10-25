import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SyncStatus, { nightlyLine } from './SyncStatus.jsx';
import HelpDot from './HelpDot.jsx';
import { signInDeps } from '../lib/signIn.js';

const NOW = new Date('2026-10-20T10:30:00');
const at = (s) => new Date(s).toISOString();

describe('SyncStatus (background sync)', () => {
  it('one time and the button; no second line', () => {
    const onSync = vi.fn();
    const { container } = render(<SyncStatus label="Sync Course" syncedAt={at('2026-10-20T10:05:00')} sync={{ state: 'fresh' }} onSync={onSync} now={NOW} />);
    expect(screen.getByText('Last successful sync')).toBeInTheDocument();
    expect(screen.getByText('10:05 AM today').closest('.sync-status__row')).not.toHaveClass('sync-status__row--stale');
    expect(container.querySelectorAll('.sync-status__row')).toHaveLength(1);
    expect(screen.queryByText(/new work/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Syncing|Waiting|failed/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sync Course' }));
    expect(onSync).toHaveBeenCalled();
  });

  it('a day old, or never: amber; never amber for an archived course, whose dot is gray', () => {
    const row = (c) => c.querySelector('.sync-status__row');
    const { rerender, container } = render(<SyncStatus label="Sync Course" syncedAt={at('2026-10-18T03:02:00')} sync={{ state: 'fresh' }} onSync={() => {}} now={NOW} />);
    expect(screen.getByText('18/10/2026 at 3:02 AM')).toBeInTheDocument();
    expect(row(container)).toHaveClass('sync-status__row--stale');
    rerender(<SyncStatus label="Sync Course" syncedAt={null} sync={{ state: 'idle' }} onSync={() => {}} now={NOW} />);
    expect(screen.getByText('none yet')).toBeInTheDocument();
    expect(row(container)).toHaveClass('sync-status__row--stale');
    rerender(<SyncStatus label="Sync Course" syncedAt={at('2026-06-18T03:02:00')} archived sync={{ state: 'idle' }} onSync={() => {}} now={NOW} />);
    expect(row(container)).not.toHaveClass('sync-status__row--stale');
    expect(row(container)).toHaveClass('sync-status__row--archived');
  });

  it('the chip: waiting, syncing, failed; clicking it opens the progress on that run', () => {
    const onOpen = vi.fn();
    const props = { label: 'Sync Course', syncedAt: at('2026-10-20T10:05:00'), onSync: () => {}, onOpen, now: NOW };
    const { rerender } = render(<SyncStatus {...props} sync={{ state: 'queued', runId: 4 }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Waiting to sync…' }));
    expect(onOpen).toHaveBeenCalledWith(4);
    rerender(<SyncStatus {...props} sync={{ state: 'running', runId: 4 }} />);
    expect(screen.getByRole('button', { name: 'Syncing…' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync Course' })).toBeDisabled();
    rerender(<SyncStatus {...props} sync={{ state: 'failed', runId: 4 }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Last sync failed' }));
    expect(onOpen).toHaveBeenLastCalledWith(4);
  });

  it('a held sync asks for the sign-in', () => {
    const spy = vi.spyOn(signInDeps, 'go').mockImplementation(() => {});
    render(<SyncStatus label="Sync Course" syncedAt={null} sync={{ state: 'held', runId: 4 }} onSync={() => {}} onOpen={() => {}} now={NOW} />);
    fireEvent.click(screen.getByRole('button', { name: 'Log in to Schoology' }));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('review: the button stays usable while the page\'s sync only waits (a press goes ahead of page syncs)', () => {
    render(<SyncStatus label="Sync Course" syncedAt={null} sync={{ state: 'queued', runId: 4 }} onSync={() => {}} onOpen={() => {}} now={NOW} />);
    expect(screen.getByRole('button', { name: 'Sync Course' })).toBeEnabled();
  });

  it('the chip sits after the Sync button, so it shows under it', () => {
    const { container } = render(<SyncStatus label="Sync Course" syncedAt={null} sync={{ state: 'failed', runId: 4 }} onSync={() => {}} onOpen={() => {}} now={NOW} />);
    const actions = container.querySelector('.sync-status__actions');
    expect([...actions.children].map((b) => b.textContent)).toEqual(['Sync Course', 'Last sync failed']);
  });

  it('label null: no Sync button, the sync time stays', () => {
    render(<SyncStatus label={null} syncedAt={at('2026-06-18T03:02:00')} archived sync={{ state: 'idle' }} onSync={() => {}} now={NOW} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('18/06/2026 at 3:02 AM')).toBeInTheDocument();
  });
});

describe('nightlyLine (blocks, calendar and alerts)', () => {
  const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600 * 1000).toISOString();

  const label = 'Blocks, calendar and alerts';
  const hint = 'Press Sync Courses to refresh them.';

  it('read 2 hours ago: the time, not amber', () => {
    expect(nightlyLine({ readAt: hoursAgo(2), nightly: true }, NOW)).toEqual({ label, time: '8:30 AM today', stale: false });
  });

  it('exactly 26 hours is still fresh; over 26 hours is amber, in whole days (at least 1)', () => {
    expect(nightlyLine({ readAt: hoursAgo(26), nightly: true }, NOW).stale).toBe(false);
    expect(nightlyLine({ readAt: hoursAgo(27), nightly: true }, NOW)).toEqual({ label, time: '1 day old', stale: true, hint });
    expect(nightlyLine({ readAt: hoursAgo(50), nightly: true }, NOW).time).toBe('2 days old');
  });

  it('never read: amber, says so', () => {
    expect(nightlyLine({ readAt: null, nightly: true }, NOW)).toEqual({ label, time: 'not read yet', stale: true, hint });
  });

  it('a night that is off promises nothing: an old read is still amber', () => {
    expect(nightlyLine({ readAt: hoursAgo(27), nightly: false }, NOW).stale).toBe(true);
  });
});

describe('SyncStatus help and nightly line', () => {
  const base = { label: 'Sync Courses', syncedAt: at('2026-10-20T10:05:00'), onSync: () => {}, now: NOW };

  it('renders the help after the time and the nightly row beneath, amber only when missed, with the hint on its time', () => {
    const { container, rerender } = render(<SyncStatus {...base} help={<HelpDot text="Help here" />} nightlyData={{ readAt: new Date(NOW.getTime() - 2 * 3600 * 1000).toISOString(), nightly: true }} />);
    const [main, night] = container.querySelectorAll('.sync-status__row');
    expect(main.querySelector('.sync-status__help').firstElementChild).toHaveClass('help-dot');
    expect(night).toHaveTextContent('Blocks, calendar and alerts8:30 AM today');
    expect(night).not.toHaveClass('sync-status__row--stale');
    rerender(<SyncStatus {...base} help={<HelpDot text="Help here" />} nightlyData={{ readAt: null, nightly: true }} />);
    expect(container.querySelectorAll('.sync-status__row')[1]).toHaveClass('sync-status__row--stale');
    expect(screen.getByRole('img', { name: 'not read yet. Press Sync Courses to refresh them.' })).toHaveTextContent('not read yet');
  });

  it('without nightlyData there is no second line; without label there is still the help', () => {
    const { container } = render(<SyncStatus {...base} label={null} help={<HelpDot text="Help here" />} />);
    expect(container.querySelectorAll('.sync-status__row')).toHaveLength(1);
    expect(screen.getByRole('img', { name: 'Help here' })).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
