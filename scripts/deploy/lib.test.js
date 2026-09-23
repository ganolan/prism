import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readlinkSync, readdirSync, symlinkSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  paths, releaseId, listReleases, currentRelease, releaseSha, swapSymlink, decide,
  planPrune, readState, writeState, acquireLock, releaseLock, KEEP_RELEASES, LABELS,
} from './lib.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'prism-root-'));
  mkdirSync(join(root, 'releases'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function makeRelease(id, sha) {
  const dir = join(root, 'releases', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'release.json'), JSON.stringify({ sha }));
  return dir;
}

describe('paths / LABELS', () => {
  it('spells out the layout under the root', () => {
    const p = paths('/Users/x/prism');
    expect(p.db).toBe('/Users/x/prism/data/students.db');
    expect(p.env).toBe('/Users/x/prism/data/.env');
    expect(p.current).toBe('/Users/x/prism/current');
    expect(LABELS.server).toBe('com.prism.server');
  });
});

describe('releaseId', () => {
  it('stamps UTC time to the second and names the commit', () => {
    expect(releaseId('9f167c5abcdef', new Date('2026-09-23T06:12:05.123Z'))).toBe('20260923T061205Z-9f167c5');
  });

  it('sorts chronologically as plain strings', () => {
    const early = releaseId(SHA_B, new Date('2026-01-02T03:04:05Z'));
    const late = releaseId(SHA_A, new Date('2026-11-12T03:04:05Z'));
    expect([late, early].sort()).toEqual([early, late]);
  });
});

describe('listReleases / currentRelease / releaseSha', () => {
  it('lists release directories oldest first and ignores anything else', () => {
    makeRelease('20260923T060000Z-bbbbbbb', SHA_B);
    makeRelease('20260922T060000Z-aaaaaaa', SHA_A);
    mkdirSync(join(root, 'releases', 'scratch'));
    expect(listReleases(root)).toEqual(['20260922T060000Z-aaaaaaa', '20260923T060000Z-bbbbbbb']);
  });

  it('is empty before the first deploy', () => {
    rmSync(join(root, 'releases'), { recursive: true });
    expect(listReleases(root)).toEqual([]);
    expect(currentRelease(root)).toBe(null);
  });

  it('reads the live release and the sha it was built from', () => {
    makeRelease('20260923T060000Z-aaaaaaa', SHA_A);
    symlinkSync(join('releases', '20260923T060000Z-aaaaaaa'), join(root, 'current'));
    expect(currentRelease(root)).toBe('20260923T060000Z-aaaaaaa');
    expect(releaseSha(root, '20260923T060000Z-aaaaaaa')).toBe(SHA_A);
    expect(releaseSha(root, 'missing')).toBe(null);
    expect(releaseSha(root, null)).toBe(null);
  });
});

describe('swapSymlink', () => {
  it('creates the link on the first deploy', () => {
    makeRelease('r1', SHA_A);
    swapSymlink(join(root, 'current'), join('releases', 'r1'));
    expect(readlinkSync(join(root, 'current'))).toBe(join('releases', 'r1'));
  });

  it('replaces the link itself — never following it into the old release', () => {
    const r1 = makeRelease('r1', SHA_A);
    makeRelease('r2', SHA_B);
    swapSymlink(join(root, 'current'), join('releases', 'r1'));
    swapSymlink(join(root, 'current'), join('releases', 'r2'));
    expect(readlinkSync(join(root, 'current'))).toBe(join('releases', 'r2'));
    // `mv new current` onto a symlink-to-directory would drop `new` INSIDE r1.
    expect(readdirSync(r1)).toEqual(['release.json']);
    expect(readdirSync(root).filter((n) => n.startsWith('current'))).toEqual(['current']);
  });
});

describe('decide', () => {
  const base = { deployedSha: SHA_A, remoteSha: SHA_B, rejected: null };

  it('does nothing when main is what is live', () => {
    expect(decide({ ...base, remoteSha: SHA_A }).action).toBe('noop');
  });

  it('does nothing when the remote could not be read', () => {
    expect(decide({ ...base, remoteSha: null }).action).toBe('noop');
  });

  it('asks for the CI verdict only once there is something new', () => {
    expect(decide(base).action).toBe('check-ci');
  });

  it('waits while CI is running or has not started', () => {
    expect(decide({ ...base, ci: 'pending' }).action).toBe('wait');
    expect(decide({ ...base, ci: 'missing' }).action).toBe('wait');
  });

  it('rejects anything but a green run', () => {
    for (const ci of ['failure', 'cancelled', 'timed_out', 'skipped']) {
      expect(decide({ ...base, ci })).toMatchObject({ action: 'reject', stage: 'ci' });
    }
  });

  it('deploys a green commit, including the very first', () => {
    expect(decide({ ...base, ci: 'success' }).action).toBe('deploy');
    expect(decide({ ...base, deployedSha: null, ci: 'success' }).action).toBe('deploy');
  });

  it('re-checks a CI rejection, because a re-run can turn it green', () => {
    expect(decide({ ...base, ci: 'success', rejected: { sha: SHA_B, stage: 'ci' } }).action).toBe('deploy');
  });

  it('never retries a commit that failed to build, failed its health check, or was rolled back', () => {
    for (const stage of ['build', 'health', 'rollback']) {
      const d = decide({ ...base, rejected: { sha: SHA_B, stage } });
      expect(d.action).toBe('noop');
      expect(d.reason).toMatch(stage);
    }
  });

  it('lets a new commit past the rejection of an older one', () => {
    expect(decide({ ...base, rejected: { sha: SHA_A, stage: 'build' } }).action).toBe('check-ci');
  });
});

describe('planPrune', () => {
  it('keeps the newest three by default', () => {
    expect(KEEP_RELEASES).toBe(3);
    expect(planPrune(['r1', 'r2', 'r3', 'r4', 'r5'], 'r5')).toEqual(['r1', 'r2']);
  });

  it('never deletes the live release or its rollback target, even after a rollback', () => {
    expect(planPrune(['r1', 'r2', 'r3', 'r4', 'r5', 'r6'], 'r3')).toEqual(['r1']);
  });

  it('has nothing to do with fewer releases than it keeps', () => {
    expect(planPrune(['r1', 'r2'], 'r2')).toEqual([]);
  });
});

describe('state', () => {
  it('round-trips', () => {
    writeState(root, { rejected: { sha: SHA_A, stage: 'build' } });
    expect(readState(root)).toEqual({ rejected: { sha: SHA_A, stage: 'build' } });
  });

  it('is empty when missing or unreadable', () => {
    expect(readState(root)).toEqual({});
    writeFileSync(paths(root).state, '{half');
    expect(readState(root)).toEqual({});
  });
});

describe('lock', () => {
  it('admits one deploy at a time', () => {
    expect(acquireLock(root)).toBe(true);
    expect(acquireLock(root)).toBe(false);
    releaseLock(root);
    expect(existsSync(paths(root).lock)).toBe(false);
    expect(acquireLock(root)).toBe(true);
    releaseLock(root);
  });

  // Review Focus 3: a deploy killed mid-run must not stop all later deploys.
  it('takes over a lock whose owner has died', () => {
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    writeFileSync(paths(root).lock, String(dead));
    expect(acquireLock(root)).toBe(true);
    releaseLock(root);
  });

  it('takes over an empty lock left by a crash between create and write', () => {
    writeFileSync(paths(root).lock, '');
    expect(acquireLock(root)).toBe(true);
    releaseLock(root);
  });
});
