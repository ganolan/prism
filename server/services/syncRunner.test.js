import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
vi.mock('./syncOrchestrator.js', () => ({ runUnifiedSync: vi.fn() }));

import { getDb } from '../db/index.js';
import { runUnifiedSync } from './syncOrchestrator.js';
import { launchSync, currentSync, SyncBusyError } from './syncRunner.js';

beforeEach(() => {
  getDb().exec('DELETE FROM sync_run_events; DELETE FROM sync_runs;');
  runUnifiedSync.mockReset();
});

describe('launchSync', () => {
  test('one sync at a time: a second launch throws SyncBusyError with the running runId', async () => {
    let finish;
    runUnifiedSync.mockImplementation((opts, emit) => new Promise((r) => { finish = () => { emit({ type: 'summary' }); r(); }; }));
    const first = launchSync({ trigger: 'scheduled' });
    expect(currentSync()).toEqual({ running: true, runId: first.runId });

    let busy;
    try { launchSync({}); } catch (err) { busy = err; }
    expect(busy).toBeInstanceOf(SyncBusyError);
    expect(busy.runId).toBe(first.runId);

    finish();
    expect(await first.done).toBe('completed');
    expect(currentSync()).toEqual({ running: false, runId: null });
  });

  test('calls onRun before the first event, numbers events, and stores the options', async () => {
    const seen = [];
    runUnifiedSync.mockImplementation(async (opts, emit) => { emit({ phase: 'schoology', status: 'running' }); emit({ type: 'summary' }); });
    const { runId, done } = launchSync({ trigger: 'scheduled' }, {
      onRun: (id) => seen.push(`run ${id}`),
      onEvent: (evt) => seen.push(evt.seq),
    });
    await done;
    expect(seen).toEqual([`run ${runId}`, 1, 2]);
    expect(JSON.parse(getDb().prepare('SELECT options_json FROM sync_runs WHERE id = ?').get(runId).options_json))
      .toEqual({ trigger: 'scheduled' });
  });

  test('resolves to the stored final status, and releases the lock when the sync throws', async () => {
    runUnifiedSync.mockImplementation(async (opts, emit) => { emit({ phase: 'mastery', status: 'error', message: 'x' }); emit({ type: 'summary' }); });
    expect(await launchSync({}).done).toBe('completed_with_errors');

    runUnifiedSync.mockRejectedValue(new Error('boom'));
    expect(await launchSync({}).done).toBe('failed');
    expect(currentSync().running).toBe(false);
  });
});
