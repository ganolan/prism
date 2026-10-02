import { describe, it, expect, vi, afterEach } from 'vitest';
import { runSync, getSyncRuns, getSyncRun, getSyncRunEvents, getCurrentSync } from './api.js';

function streamResponse(lines) {
  const body = {
    getReader() {
      let i = 0;
      const enc = new TextEncoder();
      return {
        read() {
          if (i < lines.length) {
            return Promise.resolve({ done: false, value: enc.encode(lines[i++]) });
          }
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
  return { ok: true, status: 200, body };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('runSync', () => {
  it('parses newline-delimited JSON events and calls onEvent for each', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([
      '{"phase":"schoology","status":"done"}\n{"type":',
      '"summary","mastery":[]}\n',
    ])));
    const events = [];
    await runSync({ masteryCourseIds: [1] }, (e) => events.push(e));
    expect(events).toEqual([
      { phase: 'schoology', status: 'done' },
      { type: 'summary', mastery: [] },
    ]);
  });

  it('throws a clear error on 409', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 409, json: async () => ({ error: 'Sync already in progress' }),
    }));
    await expect(runSync({}, () => {})).rejects.toThrow(/already running/i);
  });

  it('a 409 error carries the running runId so the caller can join it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 409, json: async () => ({ error: 'Sync already in progress', runId: 42 }),
    }));
    await expect(runSync({}, () => {})).rejects.toMatchObject({ status: 409, runId: 42 });
  });

  it('passes an abort signal through to fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(streamResponse(['{"type":"run","runId":7}\n']));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const events = [];
    await runSync({}, (e) => events.push(e), { signal: controller.signal });
    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
    expect(events).toEqual([{ type: 'run', runId: 7 }]);
  });

  it('throws the server-provided message on a generic error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 500, json: async () => ({ error: 'internal error' }),
    }));
    await expect(runSync({}, () => {})).rejects.toThrow('internal error');
  });
});

describe('sync run endpoints', () => {
  const ok = (body) => vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });

  it('getSyncRuns / getSyncRun / getSyncRunEvents / getCurrentSync hit the right URLs', async () => {
    const f = ok({});
    vi.stubGlobal('fetch', f);
    await getSyncRuns(30);
    await getSyncRun(5);
    await getSyncRunEvents(5, 12);
    await getCurrentSync();
    expect(f.mock.calls.map((c) => c[0])).toEqual([
      '/api/sync/runs?limit=30',
      '/api/sync/runs/5',
      '/api/sync/runs/5/events?after=12',
      '/api/sync/current',
    ]);
  });
});
