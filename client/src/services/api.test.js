import { describe, it, expect, vi, afterEach } from 'vitest';
import { runSync } from './api.js';

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

  it('throws the server-provided message on a generic error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 500, json: async () => ({ error: 'internal error' }),
    }));
    await expect(runSync({}, () => {})).rejects.toThrow('internal error');
  });
});
