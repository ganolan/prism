import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { deploy } from './deploy.js';
import { cutover, cutoverProblems, snapshotTime, mcpCommands, MAX_SNAPSHOT_AGE_MS } from './cutover.js';
import { releaseSha, currentRelease } from './lib.js';
import { snapshotName } from '../db-backup.js';
import { makeFixture } from './testing.js';

const NOW = new Date('2026-09-23T06:30:00Z');
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

let f, facts, snapDir;
beforeEach(async () => {
  f = makeFixture();
  await deploy({ root: f.root, fx: f.fx(), now: f.now, log: f.log });
  f.calls = [];
  snapDir = join(f.tmp, '_prism-data');
  mkdirSync(snapDir);
  facts = { certDomains: ['macmini.swordtail-everest.ts.net'], ssh: true, keyExpiry: null };
});
afterEach(() => f.cleanup());

function sqliteWith(path, courses) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE courses (id INTEGER PRIMARY KEY, name TEXT)');
  for (const name of courses) db.prepare('INSERT INTO courses (name) VALUES (?)').run(name);
  db.close();
  return path;
}

const snapshotAt = (date, courses = ['AP CSP']) => sqliteWith(join(snapDir, snapshotName(date)), courses);

const cfx = () => ({
  certDomains: () => facts.certDomains,
  keyExpiry: () => facts.keyExpiry,
  sshListening: () => facts.ssh,
  stopServer: () => f.calls.push(['stop']),
  startServer: () => f.calls.push(['start']),
  healthCheck: async (sha) => {
    f.calls.push(['health', sha]);
    return f.healthy(sha);
  },
  loadBackupAgent: () => f.calls.push(['backup']),
  serve: () => f.calls.push(['serve']),
});

const go = (opts) => cutover({ root: f.root, now: () => NOW, fx: cfx(), log: f.log, ...opts });
const steps = () => f.calls.map(([k]) => k);

describe('snapshotTime', () => {
  it('reads the instant from a db:backup file name', () => {
    expect(snapshotTime('students-20260923T005328Z.db').toISOString()).toBe('2026-09-23T00:53:28.000Z');
    expect(snapshotTime('students.db')).toBe(null);
  });
});

describe('cutover', () => {
  it('stops, restores, verifies, restarts, then enables backups and publishes — in that order', async () => {
    const snap = snapshotAt(new Date('2026-09-23T06:20:00Z'), ['AP CSP', 'Robotics']);

    const result = await go({ snapshotPath: snap });

    expect(steps()).toEqual(['stop', 'start', 'health', 'backup', 'serve']);
    expect(f.calls[2]).toEqual(['health', releaseSha(f.root, currentRelease(f.root))]);
    expect(sha256(f.p.db)).toBe(sha256(snap));
    expect(result.restored).toBe(snapshotName(new Date('2026-09-23T06:20:00Z')));
  });

  // Review Focus 5 — the Sep 22 trap.
  it('refuses a snapshot that was not taken just now, and says how to override', async () => {
    const snap = snapshotAt(new Date('2026-09-22T05:41:06Z'));
    await expect(go({ snapshotPath: snap })).rejects.toThrow(/hours old[\s\S]*--allow-old/);
    expect(steps()).toEqual([]);
  });

  it('accepts an old snapshot only when told to', async () => {
    const snap = snapshotAt(new Date('2026-09-22T05:41:06Z'));
    await go({ snapshotPath: snap, allowOld: true });
    expect(steps()).toContain('serve');
  });

  it('never falls back to the newest snapshot in a folder', async () => {
    snapshotAt(new Date('2026-09-23T06:20:00Z'));
    await expect(go({})).rejects.toThrow(/--snapshot/);
  });

  it('refuses a file that is not a db:backup snapshot', async () => {
    const odd = sqliteWith(join(snapDir, 'students.db'), ['x']);
    await expect(go({ snapshotPath: odd })).rejects.toThrow(/not a db:backup snapshot/);
  });

  // Review Focus 5 — something already wrote real data to prod.
  it('refuses when the prod database already holds courses', async () => {
    sqliteWith(f.p.db, ['written before cutover']);
    const snap = snapshotAt(new Date('2026-09-23T06:20:00Z'));
    await expect(go({ snapshotPath: snap })).rejects.toThrow(/already holds 1 course/);
    expect(steps()).toEqual([]);
  });

  it('lists every blocker at once', async () => {
    facts.certDomains = [];
    facts.ssh = false;
    const snap = snapshotAt(new Date('2026-09-20T00:00:00Z'));
    const err = await go({ snapshotPath: snap }).catch((e) => e);
    expect(err.problems).toHaveLength(3);
    expect(err.message).toMatch(/HTTPS Certificates/);
    expect(err.message).toMatch(/Remote Login/);
  });

  it('a dry run checks everything and changes nothing', async () => {
    const snap = snapshotAt(new Date('2026-09-23T06:20:00Z'));
    const result = await go({ snapshotPath: snap, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(steps()).toEqual([]);
  });

  // Review Focus 5 — never publish or back up a server that did not come back.
  it('does not enable backups or publish when the server is unhealthy after the restore', async () => {
    f.healthy = () => false;
    const snap = snapshotAt(new Date('2026-09-23T06:20:00Z'));
    await expect(go({ snapshotPath: snap })).rejects.toThrow(/did not come back healthy/);
    expect(steps()).toEqual(['stop', 'start', 'health']);
  });

  it('warns — but does not refuse — while tailnet key expiry is on', async () => {
    facts.keyExpiry = '2027-03-12T15:11:00Z';
    const snap = snapshotAt(new Date('2026-09-23T06:20:00Z'));
    const result = await go({ snapshotPath: snap, dryRun: true });
    expect(result.warnings.join(' ')).toMatch(/2027-03-12/);
  });
});

describe('cutoverProblems', () => {
  it('passes a fresh snapshot on a ready machine', () => {
    expect(
      cutoverProblems({
        snapshotPath: '/x/students-20260923T062000Z.db', snapshotExists: true, nowMs: NOW.getTime(),
        allowOld: false, prodCourseCount: 0, certDomains: ['a'], sshListening: true,
      }),
    ).toEqual([]);
    expect(MAX_SNAPSHOT_AGE_MS).toBe(6 * 60 * 60 * 1000);
  });
});

describe('mcpCommands', () => {
  it('gives both machines an absolute DB_PATH and a spelled-out node', () => {
    const { mini, laptop } = mcpCommands();
    expect(mini).toMatch(/-e DB_PATH=\/Users\/gnolan\/prism\/data\/students\.db/);
    expect(laptop).toMatch(/ssh gnolan@macmini '.*\/usr\/local\/bin\/node mcp\/server\.js'/);
  });
});
