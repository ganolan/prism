import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deploy } from './deploy.js';
import { acquireLock, currentRelease, paths, readState, releaseId, releaseLock, swapSymlink, writeState } from './lib.js';
import { exportTree } from './effects.js';
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

  // ---- Findings from the whole-branch review ----

  it('deletes a release that failed its health check, so rollback can never land on it', async () => {
    await run();
    const bad = f.commit('boots but crashes');
    f.healthy = (sha) => sha !== bad;
    await run();
    expect(readdirSync(f.p.releases).some((id) => id.endsWith(bad.slice(0, 7)))).toBe(false);
  });

  it('keeps the last healthy release even after repeated health failures', async () => {
    const good = await run();
    for (const name of ['bad1', 'bad2']) {
      const bad = f.commit(name);
      f.healthy = (sha) => sha !== bad;
      await run();
    }
    f.healthy = () => true;
    f.commit('fix');
    await run();
    expect(readdirSync(f.p.releases)).toContain(good.id);
  });

  it('reverts when restarting onto the new release throws', async () => {
    const first = await run();
    f.commit('next');
    const fx = f.fx();
    let restarts = 0;
    const restart = fx.restart;
    fx.restart = () => {
      restarts += 1;
      if (restarts === 1) throw new Error('Bootstrap failed: 5: Input/output error');
      restart();
    };

    const result = await deploy({ root: f.root, fx, now: f.now, log: f.log });

    expect(result).toMatchObject({ action: 'rolled-back', to: first.id });
    expect(currentRelease(f.root)).toBe(first.id);
  });

  // A deploy killed after the swap (reboot, bootout, Ctrl-C) must not leave an
  // unchecked release that the next tick mistakes for "up to date".
  function interruptedAfterSwap(sha, previousId, previousSha) {
    const id = releaseId(sha, f.now());
    const dir = join(f.p.releases, id);
    exportTree(f.p.repo, sha, dir);
    writeFileSync(join(dir, 'release.json'), JSON.stringify({ sha }));
    writeState(f.root, { ...readState(f.root), pending: { id, sha, previousId, previousSha } });
    swapSymlink(f.p.current, join('releases', id));
    return id;
  }

  it('finishes checking a deploy interrupted after the swap — and reverts an unhealthy one', async () => {
    const first = await run();
    const next = f.commit('next');
    git(f.p.repo, 'fetch', '-q', 'origin', 'main');
    const id = interruptedAfterSwap(next, first.id, readState(f.root).deployed.sha);
    f.healthy = (sha) => sha !== next;

    expect(await run()).toMatchObject({ action: 'rolled-back', to: first.id });
    expect(currentRelease(f.root)).toBe(first.id);
    expect(existsSync(join(f.p.releases, id))).toBe(false);
  });

  it('finishes checking a deploy interrupted after the swap — and keeps a healthy one', async () => {
    const first = await run();
    const next = f.commit('next');
    git(f.p.repo, 'fetch', '-q', 'origin', 'main');
    const id = interruptedAfterSwap(next, first.id, readState(f.root).deployed.sha);

    expect(await run()).toMatchObject({ action: 'deployed', id });
    expect(readState(f.root).history).toEqual([first.id, id]);
    expect(readState(f.root).pending).toBe(null);
  });

  // A cutover that failed verification leaves the server stopped on purpose;
  // a push must not deploy onto — and restart — a suspect database.
  it('deploys nothing and restarts nothing while the server is on hold', async () => {
    await run();
    f.commit('next');
    writeFileSync(paths(f.root).hold, 'integrity_check failed');
    f.calls = [];
    expect((await run()).action).toBe('held');
    expect(f.calls).toEqual([]);
  });

  // A build too slow for the watcher's tick limit is killed, discarded and
  // restarted — without a limit on that, it loops forever.
  it('stops retrying a commit whose build keeps being interrupted', async () => {
    const first = await run();
    const next = f.commit('slow build');
    const interruptBuild = () => {
      const id = releaseId(next, f.now());
      mkdirSync(join(f.p.releases, id));
      writeState(f.root, {
        ...readState(f.root),
        pending: { id, sha: next, previousId: first.id, previousSha: readState(f.root).deployed.sha },
      });
    };
    // CI held at pending so no tick builds anything itself: only the
    // interruptions can produce the rejection.
    f.ci = 'pending';
    interruptBuild();
    await run();
    expect(readState(f.root).rejected ?? null).toBe(null);
    interruptBuild();
    await run();
    expect(readState(f.root).rejected).toMatchObject({ sha: next, stage: 'build' });
    f.ci = 'success';
    expect((await run()).action).toBe('noop');
    expect(f.count('install')).toBe(1);
  });

  it('discards a release left half-built by a deploy interrupted before the swap', async () => {
    const first = await run();
    const next = f.commit('next');
    const orphan = join(f.p.releases, releaseId(next, f.now()));
    mkdirSync(orphan);
    writeState(f.root, {
      ...readState(f.root),
      pending: { id: orphan.split('/').pop(), sha: next, previousId: first.id, previousSha: readState(f.root).deployed.sha },
    });

    expect((await run()).action).toBe('deployed');
    expect(existsSync(orphan)).toBe(false);
  });
});

