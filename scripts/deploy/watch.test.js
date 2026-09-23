import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watch, tickScript, runTickProcess, TICK_MS } from './watch.js';

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'prism-watch-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('tickScript', () => {
  // Resolved through `current` on every spawn, so each tick runs the live
  // release's code — a long-lived loop would otherwise run stale deploy logic.
  it('runs tick.js from the live release', () => {
    const live = join(tmp, 'current', 'scripts', 'deploy');
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, 'tick.js'), '');
    expect(tickScript(tmp, '/fallback/tick.js')).toBe(join(live, 'tick.js'));
  });

  // Rolling back to a release from before the watcher existed must not end
  // supervision: the watcher's own tick.js stands in.
  it("falls back to the watcher's own tick.js when the live release has none", () => {
    mkdirSync(join(tmp, 'current', 'scripts', 'deploy'), { recursive: true });
    expect(tickScript(tmp, '/fallback/tick.js')).toBe('/fallback/tick.js');
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

describe('runTickProcess', () => {
  // Killing only the tick would leave its npm/vite children writing into a
  // release directory the next tick is deleting.
  it('kills the whole process tree of a tick that overruns', async () => {
    const pidFile = join(tmp, 'grandchild.pid');
    const script = join(tmp, 'slow-tick.mjs');
    writeFileSync(
      script,
      `import { spawn } from 'node:child_process';\n` +
        `import { writeFileSync } from 'node:fs';\n` +
        `const child = spawn('sleep', ['30']);\n` +
        `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));\n` +
        `setTimeout(() => {}, 60_000);\n`,
    );
    const logs = [];
    // Long enough for the child to start and spawn its grandchild on a slow CI
    // runner (800ms was not, on GitHub's ubuntu-latest), short enough to be a test.
    await expect(runTickProcess(script, { cwd: tmp, timeoutMs: 5000, log: (m) => logs.push(m) })).rejects.toThrow(/SIGKILL/);
    expect(existsSync(pidFile)).toBe(true);
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(() => process.kill(grandchild, 0)).toThrow();
    expect(logs.join('\n')).toMatch(/killing it/);
  }, 20_000);
});
