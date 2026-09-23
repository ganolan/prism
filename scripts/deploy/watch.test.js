import { describe, it, expect } from 'vitest';
import { watch, tickScript, TICK_MS } from './watch.js';

describe('tickScript', () => {
  // Resolved through `current` on every spawn, so each tick runs the live
  // release's code — a long-lived loop would otherwise run stale deploy logic.
  it('runs tick.js from the live release', () => {
    expect(tickScript('/Users/x/prism')).toBe('/Users/x/prism/current/scripts/deploy/tick.js');
  });
});

describe('watch', () => {
  it('runs a tick, then waits the interval, and repeats', async () => {
    const events = [];
    await watch({
      runTick: async () => events.push('tick'),
      sleep: async (ms) => events.push(`sleep ${ms}`),
      log: () => {},
      iterations: 3,
    });
    expect(TICK_MS).toBe(30_000);
    expect(events).toEqual(['tick', 'sleep 30000', 'tick', 'sleep 30000', 'tick']);
  });

  // launchd will not restart the watcher while the domain is on-demand-only,
  // so nothing a tick does may end the loop.
  it('survives a tick that fails', async () => {
    const logs = [];
    let ticks = 0;
    await watch({
      runTick: async () => {
        ticks += 1;
        throw new Error('tick exploded');
      },
      sleep: async () => {},
      log: (m) => logs.push(m),
      iterations: 3,
    });
    expect(ticks).toBe(3);
    expect(logs.filter((m) => /tick exploded/.test(m))).toHaveLength(3);
  });
});
