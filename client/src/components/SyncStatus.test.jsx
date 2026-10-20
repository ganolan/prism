import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SyncStatus from './SyncStatus.jsx';

const NOW = new Date('2026-10-20T10:30:00');
const at = (s) => new Date(s).toISOString();

describe('SyncStatus (#58)', () => {
  it('fresh: the synced time, the button, and the check line', () => {
    const onSync = vi.fn();
    render(<SyncStatus label="Sync Course" syncedAt={at('2026-10-20T03:02:00')} onSync={onSync} now={NOW}
      checks={[{ status: 'done', syncedAt: at('2026-10-20T10:01:00') }, { status: 'done', syncedAt: at('2026-10-20T10:05:00') }]} />);
    expect(screen.getByText('Synced 03:02 today')).toBeInTheDocument();
    expect(screen.getByText('Synced 03:02 today').closest('.sync-status')).not.toHaveClass('sync-status--stale');
    expect(screen.getByRole('status').textContent).toBe('Checked for new work at 10:05 today.');
    fireEvent.click(screen.getByRole('button', { name: 'Sync Course' }));
    expect(onSync).toHaveBeenCalled();
  });

  it('a day or more old, or never: the amber tone', () => {
    const { rerender, container } = render(<SyncStatus label="Sync Course" syncedAt={at('2026-10-18T03:02:00')} onSync={() => {}} now={NOW} />);
    expect(screen.getByText('Synced 18/10/2026, 03:02')).toBeInTheDocument();
    expect(container.querySelector('.sync-status')).toHaveClass('sync-status--stale');
    rerender(<SyncStatus label="Sync Course" syncedAt={null} onSync={() => {}} now={NOW} />);
    expect(screen.getByText('Not synced yet')).toBeInTheDocument();
    expect(container.querySelector('.sync-status')).toHaveClass('sync-status--stale');
  });

  it('checking: the check line says so', () => {
    render(<SyncStatus label="Sync Course" syncedAt={at('2026-10-20T03:02:00')} onSync={() => {}} now={NOW}
      checks={[{ status: 'refreshing' }, { status: 'done', syncedAt: at('2026-10-20T10:05:00') }]} />);
    expect(screen.getByRole('status').textContent).toBe('Checking Schoology for new work…');
  });

  it('a failed check: the reason, and the sign-in when the session lapsed', () => {
    render(<SyncStatus label="Sync Course" syncedAt={at('2026-10-20T03:02:00')} onSync={() => {}} now={NOW}
      checks={[{ status: 'error', error: 'expired', signIn: true }, { status: 'done', syncedAt: at('2026-10-20T10:05:00') }]} />);
    expect(screen.getByRole('status').textContent).toMatch(/^Could not check Schoology for new work\./);
    expect(screen.getByRole('button', { name: 'Log in to Schoology' })).toBeInTheDocument();
  });

  it('syncing: the button is disabled and says so', () => {
    render(<SyncStatus label="Sync Assignment" syncedAt={null} syncing onSync={() => {}} now={NOW} />);
    expect(screen.getByRole('button', { name: 'Syncing…' })).toBeDisabled();
  });
});
