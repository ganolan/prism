import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
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

  it('heading reflects each finished state', () => {
    const base = { ...RUNNING, summary: { elapsedMs: 1000 } };
    const { rerender } = render(
      <SyncProgress reduced={{ ...base, failures: [], fatal: false }} mode="done"
        onDone={noop} onRetry={noop} onLogin={noop} />
    );
    expect(screen.getByText('Sync complete')).toBeInTheDocument();

    rerender(
      <SyncProgress mode="done" onDone={noop} onRetry={noop} onLogin={noop}
        reduced={{ ...base, fatal: false, failures: [
          { key: 'mastery:1', kind: 'mastery', courseId: 1, label: 'Mastery · Biology 9', errorKind: 'other', message: 'x' },
        ] }} />
    );
    expect(screen.getByText('Sync finished with issues')).toBeInTheDocument();

    rerender(
      <SyncProgress mode="done" onDone={noop} onRetry={noop} onLogin={noop}
        reduced={{ ...base, failures: [], fatal: true }} />
    );
    expect(screen.getByText('Sync failed')).toBeInTheDocument();
  });

  it('renders the progress bar width from progress', () => {
    const { container } = render(
      <SyncProgress reduced={RUNNING} mode="running" onDone={noop} onRetry={noop} onLogin={noop} />
    );
    expect(container.querySelector('.sync-bar-fill').style.width).toBe('50%');
  });

  it('renders log lines', () => {
    render(<SyncProgress reduced={RUNNING} mode="running" onDone={noop} onRetry={noop} onLogin={noop} />);
    expect(screen.getByText('Fetched 4 sections')).toBeInTheDocument();
  });

  it('calls onDone when Done is clicked', () => {
    const onDone = vi.fn();
    render(
      <SyncProgress reduced={{ ...RUNNING, summary: { elapsedMs: 1000 } }} mode="done"
        onDone={onDone} onRetry={noop} onLogin={noop} />
    );
    fireEvent.click(screen.getByRole('button', { name: /done/i }));
    expect(onDone).toHaveBeenCalled();
  });

  it('calls onRetry with the failed course id', () => {
    const onRetry = vi.fn();
    const reduced = { ...RUNNING, failures: [
      { key: 'mastery:1', kind: 'mastery', courseId: 1, label: 'Mastery · Biology 9', errorKind: 'other', message: 'x' },
    ] };
    render(<SyncProgress reduced={reduced} mode="done" onDone={noop} onRetry={onRetry} onLogin={noop} />);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledWith([1]);
  });

  it('shows an informational banner when courses are waiting on PowerSchool (#126)', () => {
    const reduced = {
      ...RUNNING,
      phases: [
        ...RUNNING.phases,
        { key: 'blocks', kind: 'blocks', label: 'PowerSchool blocks', status: 'done', records: 0, notReady: 2 },
      ],
    };
    render(<SyncProgress reduced={reduced} mode="done" onDone={noop} onRetry={noop} onLogin={noop} />);
    expect(screen.getByText(/2 courses don't have a PowerSchool block number yet/)).toBeInTheDocument();
    expect(screen.getByText(/resolves automatically on a later sync/)).toBeInTheDocument();
  });

  it('uses singular phrasing for exactly one course waiting on PowerSchool', () => {
    const reduced = {
      ...RUNNING,
      phases: [
        ...RUNNING.phases,
        { key: 'blocks', kind: 'blocks', label: 'PowerSchool blocks', status: 'done', records: 0, notReady: 1 },
      ],
    };
    render(<SyncProgress reduced={reduced} mode="done" onDone={noop} onRetry={noop} onLogin={noop} />);
    expect(screen.getByText(/1 course doesn't have a PowerSchool block number yet/)).toBeInTheDocument();
  });

  it('shows no PowerSchool-pending banner when every course resolved', () => {
    const reduced = {
      ...RUNNING,
      phases: [
        ...RUNNING.phases,
        { key: 'blocks', kind: 'blocks', label: 'PowerSchool blocks', status: 'done', records: 5, notReady: 0 },
      ],
    };
    render(<SyncProgress reduced={reduced} mode="done" onDone={noop} onRetry={noop} onLogin={noop} />);
    expect(screen.queryByText(/PowerSchool block number/)).not.toBeInTheDocument();
  });

  it('shows a login remedy banner for a blocks-phase login failure, and retries via onRetryBlocks (#126)', () => {
    const onRetryBlocks = vi.fn();
    const reduced = {
      ...RUNNING,
      phases: [
        ...RUNNING.phases,
        { key: 'blocks', kind: 'blocks', label: 'PowerSchool blocks', status: 'error', errorKind: 'login', message: 'Not logged in to Schoology' },
      ],
      failures: [{ key: 'blocks', kind: 'blocks', label: 'PowerSchool blocks', errorKind: 'login', message: 'Not logged in to Schoology' }],
      retryEnabled: true,
    };
    render(
      <SyncProgress reduced={reduced} mode="done" retryEnabled={true}
        onDone={noop} onRetry={noop} onRetryBlocks={onRetryBlocks} onLogin={noop} />
    );
    const banner = screen.getByTestId('remedy-blocks');
    expect(banner.className).toMatch(/alert-warning/);
    fireEvent.click(within(banner).getByRole('button', { name: /retry/i }));
    expect(onRetryBlocks).toHaveBeenCalled();
  });

  it('shows no remedy banner for a Schoology-phase failure (no courseId)', () => {
    const reduced = {
      ...RUNNING,
      failures: [{ key: 'schoology', kind: 'schoology', label: 'Schoology data', status: 'error' }],
      fatal: true,
    };
    render(<SyncProgress reduced={reduced} mode="done" onDone={noop} onRetry={noop} onLogin={noop} />);
    expect(screen.queryByTestId('remedy-schoology')).not.toBeInTheDocument();
  });
});
