import { describe, it, expect, vi, beforeEach } from 'vitest';

// Record every command instead of running it. `launchctl print` (spawnSync)
// answers "not loaded", as it does for an agent that was just written.
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => ''),
  spawnSync: vi.fn(() => ({ status: 1 })),
  spawn: vi.fn(),
}));

const { execFileSync } = await import('node:child_process');
const { cutoverEffects, start, fetchMain } = await import('./effects.js');

const commands = () => execFileSync.mock.calls.map(([cmd, args]) => [cmd, ...(args ?? [])].join(' '));

beforeEach(() => execFileSync.mockClear());

// While the GUI domain is on-demand-only, a bootstrap alone never starts a job:
// only an explicit kickstart does (observed on the mini, 2026-09-23).
describe('starting a launchd job', () => {
  it('bootstraps it and then kickstarts it', () => {
    start('com.prism.deploy');
    expect(commands()).toEqual([
      expect.stringMatching(/^launchctl bootstrap gui\/\d+ .*com\.prism\.deploy\.plist$/),
      expect.stringMatching(/^launchctl kickstart gui\/\d+\/com\.prism\.deploy$/),
    ]);
  });

  it('cutover brings the server back with a kickstart, not a bare bootstrap', () => {
    cutoverEffects('/tmp/prism-fixture').startServer();
    expect(commands().some((c) => /^launchctl kickstart gui\/\d+\/com\.prism\.server$/.test(c))).toBe(true);
  });
});

// A stalled network must not hang a tick until the watcher kills it.
describe('network calls are bounded', () => {
  it('git fetch runs with a timeout', () => {
    fetchMain('/tmp/repo');
    const [, , opts] = execFileSync.mock.calls.find(([cmd, args]) => cmd === 'git' && args.includes('fetch'));
    expect(opts.timeout).toBeGreaterThan(0);
  });
});

// Prism is published as its own Tailscale Service (prism.<tailnet>.ts.net) since
// 2026-09-25, not on the machine's name — a rebuild must recreate that.
describe('publishing on the tailnet', () => {
  it('serves prod as the prism Tailscale Service', () => {
    cutoverEffects('/tmp/prism-fixture').serve();
    expect(commands()).toContain('tailscale serve --service=svc:prism --https=443 127.0.0.1:3001');
  });
});
