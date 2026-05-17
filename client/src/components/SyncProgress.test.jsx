import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import SyncProgress from './SyncProgress.jsx';

const RUNNING = {
  phases: [
    { key: 'schoology', kind: 'schoology', label: 'Schoology data', status: 'done', records: 418 },
    { key: 'mastery:1', kind: 'mastery', courseId: 1, label: 'Mastery · Biology 9', status: 'running' },
  ],
  logLines: ['Fetched 4 sections'],
  failures: [],
  progress: 0.5,
  summary: null,
  fatal: false,
};

function noop() {}

describe('SyncProgress', () => {
  it('lists each phase with its status', () => {
    render(<SyncProgress reduced={RUNNING} mode="running" onDone={noop} onRetry={noop} onLogin={noop} />);
    expect(screen.getByText('Schoology data')).toBeInTheDocument();
    expect(screen.getByText('Mastery · Biology 9')).toBeInTheDocument();
  });

  it('disables the Done button while running', () => {
    render(<SyncProgress reduced={RUNNING} mode="running" onDone={noop} onRetry={noop} onLogin={noop} />);
    expect(screen.getByRole('button', { name: /done/i })).toBeDisabled();
  });

  it('enables Done when the sync is finished', () => {
    const done = { ...RUNNING, mode: 'done' };
    render(<SyncProgress reduced={done} mode="done" onDone={noop} onRetry={noop} onLogin={noop} />);
    expect(screen.getByRole('button', { name: /done/i })).toBeEnabled();
  });

  it('shows an amber login-remedy banner for a login failure', () => {
    const reduced = {
      ...RUNNING,
      failures: [{ key: 'mastery:1', courseId: 1, label: 'Mastery · Biology 9', errorKind: 'login', message: 'expired' }],
    };
    render(<SyncProgress reduced={reduced} mode="done" onDone={noop} onRetry={noop} onLogin={noop} />);
    const banner = screen.getByTestId('remedy-mastery:1');
    expect(banner.className).toMatch(/alert-warning/);
    expect(within(banner).getByRole('button', { name: /log in to schoology/i })).toBeInTheDocument();
  });

  it('shows a plain error-remedy banner for a generic failure', () => {
    const reduced = {
      ...RUNNING,
      failures: [{ key: 'mastery:1', courseId: 1, label: 'Mastery · Biology 9', errorKind: 'other', message: 'page timeout' }],
    };
    render(<SyncProgress reduced={reduced} mode="done" onDone={noop} onRetry={noop} onLogin={noop} />);
    const banner = screen.getByTestId('remedy-mastery:1');
    expect(banner.className).toMatch(/alert-error/);
    expect(screen.getByText(/page timeout/)).toBeInTheDocument();
  });
});
