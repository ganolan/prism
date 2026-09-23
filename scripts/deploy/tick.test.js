import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { superviseTick, backupDue, localDate, BACKUP_HOUR, MISSES_BEFORE_RESTART } from './tick.js';
import { acquireLock, paths, releaseLock } from './lib.js';

let root, calls, logs, fx, answers, backupLoaded;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'prism-tick-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  calls = [];
  logs = [];
  answers = true;
  backupLoaded = true;
  fx = {
    deploy: async () => {
      calls.push('deploy');
      return { action: 'noop' };
    },
    serverAnswers: async () => {
      calls.push('probe');
      return answers;
    },
    restartServer: () => calls.push('restart'),
    backupLoaded: () => backupLoaded,
    startBackup: () => calls.push('backup'),
  };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// Local-time constructor, so these hold in any timezone (CI runs in UTC).
const at = (h, m = 0, day = 24) => new Date(2026, 8, day, h, m);
const tick = (now = at(10)) => superviseTick({ root, now: () => now, fx, log: (m) => logs.push(m) });

describe('superviseTick — deploy', () => {
  it('runs a deploy every tick', async () => {
    await tick();
    expect(calls).toContain('deploy');
  });

  it('keeps supervising when the deploy throws', async () => {
    fx.deploy = async () => {
      throw new Error('git fetch exploded');
    };
    const result = await tick();
    expect(result.server).toBe('up');
    expect(logs.join('\n')).toMatch(/git fetch exploded/);
  });

  // A deploy that hangs on a stalled network is killed by the watcher before
  // anything after it runs — so the watchdog goes first.
  it('checks on the server before it deploys', async () => {
    await tick();
    expect(calls.indexOf('probe')).toBeLessThan(calls.indexOf('deploy'));
  });
});

describe('superviseTick — watchdog', () => {
  it('leaves an answering server alone', async () => {
    expect((await tick()).server).toBe('up');
    expect(calls).not.toContain('restart');
  });

  // launchd's KeepAlive is held back while the domain is on-demand-only;
  // an explicit kickstart is the only restart that happens.
  // A long sync can block the server's event loop past one probe; restarting
  // on a single miss would kill the teacher's sync mid-run.
  it(`restarts only after ${MISSES_BEFORE_RESTART} missed probes in a row, and says so once`, async () => {
    expect(MISSES_BEFORE_RESTART).toBe(3);
    answers = false;
    expect((await tick()).server).toBe('down');
    expect((await tick()).server).toBe('down');
    expect((await tick()).server).toBe('restarted');
    expect((await tick()).server).toBe('restarted');
    expect(calls.filter((c) => c === 'restart')).toHaveLength(2);
    expect(logs.filter((m) => /not answering/.test(m))).toHaveLength(1);
  });

  it('forgets earlier misses once the server answers', async () => {
    answers = false;
    await tick();
    await tick();
    answers = true;
    await tick();
    answers = false;
    expect((await tick()).server).toBe('down');
    expect(calls).not.toContain('restart');
  });

  it('notes when the server answers again', async () => {
    answers = false;
    for (let i = 0; i < MISSES_BEFORE_RESTART; i++) await tick();
    answers = true;
    await tick();
    expect(logs.join('\n')).toMatch(/answering again/);
  });

  it('keeps its hands off while a deploy or cutover holds the lock', async () => {
    answers = false;
    fx.deploy = async () => ({ action: 'locked' });
    expect(acquireLock(root)).toBe(true);
    expect((await tick()).server).toBe('locked');
    expect(calls).not.toContain('restart');
    releaseLock(root);
  });

  // A cutover that failed verification leaves the server STOPPED on purpose.
  it('never restarts a server that cutover left on hold', async () => {
    answers = false;
    writeFileSync(paths(root).hold, 'integrity_check failed');
    expect((await tick()).server).toBe('held');
    expect(calls).not.toContain('restart');
  });
});

describe('superviseTick — nightly backup', () => {
  it(`starts the backup once a day, from ${BACKUP_HOUR}:00`, async () => {
    expect((await tick(at(1, 59))).backup).toBe('not-due');
    expect((await tick(at(2, 0))).backup).toBe('started');
    expect((await tick(at(2, 1))).backup).toBe('not-due');
    expect((await tick(at(2, 0, 25))).backup).toBe('started');
    expect(calls.filter((c) => c === 'backup')).toHaveLength(2);
  });

  it('catches up later in the day if 02:00 was missed', async () => {
    expect((await tick(at(9, 30))).backup).toBe('started');
  });

  // Review Focus 4: before cutover prod's database is empty; an empty snapshot
  // would become the newest file the laptop's db:restore picks.
  it('never starts a backup before cutover has loaded the backup agent', async () => {
    backupLoaded = false;
    expect((await tick(at(3))).backup).toBe('not-loaded');
    expect(calls).not.toContain('backup');
  });

  it('remembers the day across ticks in its own state file', async () => {
    await tick(at(3));
    expect(JSON.parse(readFileSync(paths(root).watchState, 'utf8')).lastBackupDate).toBe(localDate(at(3)));
  });
});

describe('backupDue', () => {
  it('is due from the backup hour on a day not yet backed up', () => {
    expect(backupDue({ now: at(2), lastBackupDate: null })).toBe(true);
    expect(backupDue({ now: at(1), lastBackupDate: null })).toBe(false);
    expect(backupDue({ now: at(5), lastBackupDate: localDate(at(5)) })).toBe(false);
  });
});
