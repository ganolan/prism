import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { deploy } from './deploy.js';
import { rollback } from './rollback.js';
import { currentRelease, readState, releaseSha } from './lib.js';
import { makeFixture } from './testing.js';

let f;
beforeEach(() => {
  f = makeFixture();
});
afterEach(() => f.cleanup());

const run = (opts = {}) => deploy({ root: f.root, fx: f.fx(), now: f.now, log: f.log, ...opts });
const back = () => rollback({ root: f.root, fx: f.fx(), now: f.now, log: f.log });

describe('rollback', () => {
  it('points current at the previous release, restarts, and checks it answers', async () => {
    const a = await run();
    f.commit('b');
    const b = await run();

    const result = await back();

    expect(result).toMatchObject({ from: b.id, to: a.id, healthy: true });
    expect(currentRelease(f.root)).toBe(a.id);
    expect(f.calls.at(-1)).toEqual(['health', releaseSha(f.root, a.id)]);
  });

  // Review Focus 2.
  it('stops the poller redeploying the commit that was just rolled back', async () => {
    const a = await run();
    f.commit('b');
    await run();
    await back();

    expect((await run()).action).toBe('noop');
    expect(currentRelease(f.root)).toBe(a.id);
  });

  it('still holds after a second rollback', async () => {
    const a = await run();
    f.commit('b');
    await run();
    f.commit('c');
    await run();

    await back();
    await back();

    expect(currentRelease(f.root)).toBe(a.id);
    expect((await run()).action).toBe('noop');
  });

  it('lets a new commit on main deploy normally', async () => {
    await run();
    f.commit('b');
    await run();
    await back();
    const fix = f.commit('fix');

    expect((await run()).action).toBe('deployed');
    expect(readState(f.root).deployed.sha).toBe(fix);
  });

  it('deploy --force undoes the pause', async () => {
    await run();
    const b = f.commit('b');
    await run();
    await back();

    expect((await run({ force: true })).action).toBe('deployed');
    expect(readState(f.root).deployed.sha).toBe(b);
  });

  it('pins the commit it rolled away from when GitHub is unreachable', async () => {
    await run();
    const b = f.commit('b');
    await run();
    const fx = { ...f.fx(), fetchMain: () => { throw new Error('offline'); } };

    const result = await rollback({ root: f.root, fx, now: f.now, log: f.log });

    expect(result.pinned).toBe(b);
    expect(readState(f.root).rejected).toMatchObject({ sha: b, stage: 'rollback' });
  });

  it('refuses when there is nothing older', async () => {
    await run();
    await expect(back()).rejects.toThrow(/No release older/);
  });

  it('reports an unhealthy target instead of hiding it', async () => {
    await run();
    f.commit('b');
    await run();
    f.healthy = () => false;
    expect((await back()).healthy).toBe(false);
  });
});
