import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SyncStatus from './SyncStatus.jsx';
import { signInDeps } from '../lib/signIn.js';

const NOW = new Date('2026-10-20T10:30:00');
const at = (s) => new Date(s).toISOString();

describe('SyncStatus (background sync)', () => {
  it('one time and the button; no second line', () => {
    const onSync = vi.fn();
    const { container } = render(<SyncStatus label="Sync Course" syncedAt={at('2026-10-20T10:05:00')} sync={{ state: 'fresh' }} onSync={onSync} now={NOW} />);
    expect(screen.getByText('Synced 10:05 today')).toBeInTheDocument();
    expect(container.querySelector('.sync-status')).not.toHaveClass('sync-status--stale');
    expect(screen.queryByText(/new work/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Syncing|Waiting|failed/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sync Course' }));
    expect(onSync).toHaveBeenCalled();
  });

  it('a day old, or never: amber; never amber for an archived course', () => {
    const { rerender, container } = render(<SyncStatus label="Sync Course" syncedAt={at('2026-10-18T03:02:00')} sync={{ state: 'fresh' }} onSync={() => {}} now={NOW} />);
    expect(container.querySelector('.sync-status')).toHaveClass('sync-status--stale');
    rerender(<SyncStatus label="Sync Course" syncedAt={null} sync={{ state: 'idle' }} onSync={() => {}} now={NOW} />);
    expect(screen.getByText('Not synced yet')).toBeInTheDocument();
    rerender(<SyncStatus label="Sync Course" syncedAt={at('2026-06-18T03:02:00')} archived sync={{ state: 'idle' }} onSync={() => {}} now={NOW} />);
    expect(container.querySelector('.sync-status')).not.toHaveClass('sync-status--stale');
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
    fireEvent.click(screen.getByRole('button', { name: 'Sync failed' }));
    expect(onOpen).toHaveBeenLastCalledWith(4);
  });

  it('a held sync asks for the sign-in', () => {
    const spy = vi.spyOn(signInDeps, 'go').mockImplementation(() => {});
    render(<SyncStatus label="Sync Course" syncedAt={null} sync={{ state: 'held', runId: 4 }} onSync={() => {}} onOpen={() => {}} now={NOW} />);
    fireEvent.click(screen.getByRole('button', { name: 'Log in to Schoology' }));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
