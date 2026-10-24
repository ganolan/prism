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
  const waitFor = async (check, ms) => {
    const until = Date.now() + ms;
    while (!check()) {
      if (Date.now() > until) throw new Error('timed out waiting');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  // Killing only the tick would leave its npm/vite children writing into a
  // release directory the next tick is deleting. The kill waits for the
  // grandchild to exist (a signal, not a timer): a fixed timer raced the
  // child's start on a loaded CI runner (800 ms failed, then 5 s, 24 Oct 2026).
  it('kills the whole process tree of a tick', async () => {
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
    const abort = new AbortController();
    const run = runTickProcess(script, { cwd: tmp, timeoutMs: 60_000, signal: abort.signal });
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', 20_000);
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    abort.abort();
    await expect(run).rejects.toThrow(/SIGKILL/);
    await waitFor(() => { try { process.kill(grandchild, 0); return false; } catch { return true; } }, 2_000);
  }, 30_000);

  it('a tick that overruns its time is killed, and the log says so', async () => {
    const script = join(tmp, 'stuck-tick.mjs');
    writeFileSync(script, 'setTimeout(() => {}, 60_000);\n');
    const logs = [];
    await expect(runTickProcess(script, { cwd: tmp, timeoutMs: 300, log: (m) => logs.push(m) })).rejects.toThrow(/SIGKILL/);
    expect(logs.join('\n')).toMatch(/killing it/);
  });
});
