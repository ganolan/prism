import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { deploy } from './deploy.js';
import { acquireLock, currentRelease, readState, releaseLock } from './lib.js';
import { git, makeFixture } from './testing.js';

let f;
beforeEach(() => {
  f = makeFixture();
});
afterEach(() => f.cleanup());

const run = (opts = {}) => deploy({ root: f.root, fx: f.fx(), now: f.now, log: f.log, ...opts });

describe('deploy', () => {
  it('deploys the first release: tree, release.json, .env, current, restart', async () => {
    const sha = git(f.origin, 'rev-parse', 'HEAD');
    const result = await run();

    expect(result.action).toBe('deployed');
    const dir = join(f.p.releases, result.id);
    expect(readlinkSync(f.p.current)).toBe(join('releases', result.id));
    expect(JSON.parse(readFileSync(join(dir, 'release.json'), 'utf8')).sha).toBe(sha);
    expect(existsSync(join(dir, 'package.json'))).toBe(true);
    expect(existsSync(join(dir, '.git'))).toBe(false);
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('SCHOOLOGY_CONSUMER_KEY=fixture\n');
    expect(f.calls.filter(([k]) => k === 'restart')).toEqual([['restart', result.id]]);
    expect(readState(f.root).deployed.sha).toBe(sha);
  });

  it('does nothing — not even a CI query — when main is already live', async () => {
    await run();
    f.calls = [];
    expect((await run()).action).toBe('noop');
    expect(f.calls).toEqual([]);
  });

  it('waits for CI and builds nothing meanwhile', async () => {
    await run();
    f.commit('next');
    f.ci = 'pending';
    expect((await run()).action).toBe('wait');
    expect(f.count('install')).toBe(1);
  });

  it('refuses a red commit, says so once, and leaves prod alone', async () => {
    const first = await run();
    f.commit('broken');
    f.ci = 'failure';
    await run();
    await run();
    expect(currentRelease(f.root)).toBe(first.id);
    expect(f.logs.filter((m) => m.includes('CI failure'))).toHaveLength(1);
  });

  it('deploys a commit whose CI was re-run green', async () => {
    await run();
    const sha = f.commit('flaky');
    f.ci = 'failure';
    await run();
    f.ci = 'success';
    expect((await run()).action).toBe('deployed');
    expect(readState(f.root).deployed.sha).toBe(sha);
  });

  it('a failed build leaves the live release running and is not retried every tick', async () => {
    const first = await run();
    f.commit('bad deps');
    f.buildFails = true;

    expect(await run()).toMatchObject({ action: 'failed', stage: 'build' });
    expect(currentRelease(f.root)).toBe(first.id);
    expect(readdirSync(f.p.releases)).toEqual([first.id]);
    expect(f.count('restart')).toBe(1);

    expect((await run()).action).toBe('noop');
    expect(f.count('install')).toBe(2);
  });

  it('--force retries a commit that failed to build', async () => {
    await run();
    f.commit('bad deps');
    f.buildFails = true;
    await run();
    f.buildFails = false;
    expect((await run({ force: true })).action).toBe('deployed');
  });

  it('swaps back and restarts the previous release when the new one is unhealthy', async () => {
    const first = await run();
    const bad = f.commit('boots but crashes');
    f.healthy = (sha) => sha !== bad;

    expect(await run()).toMatchObject({ action: 'rolled-back', to: first.id });
    expect(currentRelease(f.root)).toBe(first.id);
    expect(f.calls.filter(([k]) => k === 'restart').at(-1)).toEqual(['restart', first.id]);
    expect(readState(f.root).rejected).toMatchObject({ sha: bad, stage: 'health' });
  });

  it('keeps only the newest three releases', async () => {
    for (let i = 0; i < 5; i++) {
      f.commit(`c${i}`);
      await run();
    }
    expect(readdirSync(f.p.releases)).toHaveLength(3);
    expect(readdirSync(f.p.releases)).toContain(currentRelease(f.root));
  });

  it('stands aside while another deploy holds the lock', async () => {
    expect(acquireLock(f.root)).toBe(true);
    expect((await run()).action).toBe('locked');
    expect(f.calls).toEqual([]);
    releaseLock(f.root);
  });
});
