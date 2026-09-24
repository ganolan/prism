#!/usr/bin/env node
/**
 * The cutover runbook as a script (spec §1 "Cutover"). Run on the mini, by the
 * owner, once the laptop is quiet:
 *
 *   1. on the laptop: stop the dev server and every Claude session with prism
 *      loaded; npm run db:backup; wait for OneDrive to sync it
 *   2. on the mini:   node ~/prism/current/scripts/deploy/cutover.js --snapshot <that file>
 *
 * It refuses to guess the snapshot, refuses one that was not taken just now
 * (restoring an old one silently drops every change since, and integrity_check
 * still passes), refuses to overwrite a prod database that already holds data,
 * and publishes nothing until the restored server answers.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import Database from 'better-sqlite3';
import { isMain } from '../../server/lib/isMain.js';
import { SNAPSHOT_RE } from '../db-backup.js';
import { restore } from '../db-restore.js';
import { acquireLock, currentRelease, paths, releaseLock, releaseSha } from './lib.js';

export const MAX_SNAPSHOT_AGE_MS = 6 * 60 * 60 * 1000;

/** `students-20260923T005328Z.db` → its instant; null for anything else. */
export function snapshotTime(name) {
  const m = SNAPSHOT_RE.exec(name);
  if (!m) return null;
  const s = m[1];
  return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);
}

export function cutoverProblems({ snapshotPath, snapshotExists, nowMs, allowOld, prodCourseCount, certDomains, sshListening }) {
  const problems = [];
  if (!snapshotPath) {
    problems.push(
      'Pass --snapshot <file>: the snapshot taken on the laptop for this cutover. The script never picks ' +
        '"the newest in the folder" — an old one would silently drop every change made since.',
    );
  } else if (!snapshotExists) {
    problems.push(`Snapshot not found: ${snapshotPath}`);
  } else {
    const taken = snapshotTime(basename(snapshotPath));
    if (!taken) {
      problems.push(`${basename(snapshotPath)} is not a db:backup snapshot (students-YYYYMMDDTHHMMSSZ.db).`);
    } else if (nowMs - taken.getTime() > MAX_SNAPSHOT_AGE_MS && !allowOld) {
      const hours = Math.round((nowMs - taken.getTime()) / 3_600_000);
      problems.push(
        `That snapshot is ${hours} hours old. Cutover needs one taken just now: stop the laptop's writers, ` +
          'run npm run db:backup there, and pass the new file. --allow-old overrides.',
      );
    }
  }
  if (prodCourseCount > 0) {
    problems.push(
      `The prod database already holds ${prodCourseCount} course(s) — something wrote real data to it before ` +
        'cutover. Refusing to overwrite it; find out what first.',
    );
  }
  if (!certDomains?.length) {
    problems.push('HTTPS Certificates are not enabled on the tailnet: Tailscale admin console → DNS → enable HTTPS Certificates.');
  }
  if (!sshListening) {
    problems.push(
      'Remote Login is off, so the laptop cannot reach PrisMCP over SSH: System Settings → General → Sharing → Remote Login.',
    );
  }
  return problems;
}

export function cutoverWarnings({ keyExpiry }) {
  return keyExpiry
    ? [`Tailnet key expiry is on for this node (expires ${keyExpiry.slice(0, 10)}); when it lapses the mini drops off the tailnet. Admin console → Machines → macmini → Disable key expiry.`]
    : [];
}

export function mcpCommands() {
  return {
    mini:
      'claude mcp remove prism -s user; claude mcp add prism -s user -e DB_PATH=/Users/gnolan/prism/data/students.db ' +
      '-- /usr/local/bin/node /Users/gnolan/prism/current/mcp/server.js',
    laptop:
      'claude mcp remove prism -s user; claude mcp add prism -s user -- ssh gnolan@macmini ' +
      "'cd ~/prism/current && DB_PATH=$HOME/prism/data/students.db /usr/local/bin/node mcp/server.js'",
  };
}

function countCourses(dbPath) {
  if (!existsSync(dbPath)) return 0;
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      return db.prepare('SELECT COUNT(*) AS n FROM courses').get().n;
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function integrity(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.pragma('integrity_check', { simple: true });
  } finally {
    db.close();
  }
}

export async function cutover({ root, snapshotPath, allowOld = false, dryRun = false, now = () => new Date(), fx, log = () => {} }) {
  const p = paths(root);
  const problems = cutoverProblems({
    snapshotPath,
    snapshotExists: Boolean(snapshotPath) && existsSync(snapshotPath),
    nowMs: now().getTime(),
    allowOld,
    prodCourseCount: countCourses(p.db),
    certDomains: fx.certDomains(),
    sshListening: await fx.sshListening(),
  });
  const warnings = cutoverWarnings({ keyExpiry: fx.keyExpiry() });
  if (problems.length) {
    const err = new Error(`Cutover preconditions failed:\n${problems.map((x) => `  - ${x}`).join('\n')}`);
    err.problems = problems;
    err.warnings = warnings;
    throw err;
  }

  const liveSha = releaseSha(root, currentRelease(root));
  if (!liveSha) throw new Error('No release is deployed yet — run npm run prism:install first.');

  if (dryRun) {
    return {
      dryRun: true,
      warnings,
      steps: ['stop the server', `restore ${basename(snapshotPath)} into ${p.db}`, 'verify sha-256 and integrity_check',
        'start the server and wait for it to answer', 'load the nightly backup agent', 'tailscale serve --service=svc:prism --https=443 127.0.0.1:3001'],
    };
  }

  // Hold the deploy lock for the whole replacement: a push landing mid-cutover
  // would otherwise restart the server this just stopped, possibly while the
  // database file is being swapped, or swap `current` under the health check.
  if (!acquireLock(root)) {
    throw new Error('A deploy is running. Wait for it to finish (tail ~/prism/logs/deploy.log), then re-run.');
  }
  try {
    // Keeps the watchdog from restarting the server while the database is being
    // replaced — and afterwards, if anything below fails and leaves it stopped.
    writeFileSync(p.hold, `cutover started ${now().toISOString()}\n`);
    log('stopping the prod server');
    fx.stopServer();
    const restored = await restore({ dbPath: p.db, snapshotFile: snapshotPath, force: true });
    if (sha256(p.db) !== sha256(snapshotPath)) {
      throw new Error('The restored database does not match the snapshot byte for byte. The server is left STOPPED.');
    }
    const ic = integrity(p.db);
    if (ic !== 'ok') throw new Error(`integrity_check returned "${ic}". The server is left STOPPED.`);
    log(`restored ${restored.snapshot}; sha-256 and integrity_check ok`);

    log('starting the prod server');
    fx.startServer();
    if (!(await fx.healthCheck(liveSha))) {
      throw new Error('The server did not come back healthy after the restore. Nothing was published. See ~/prism/logs/server.log.');
    }

    fx.loadBackupAgent();
    log('nightly backup agent loaded');
    fx.serve();
    log('published on the tailnet');
    rmSync(p.hold, { force: true });
    return { restored: restored.snapshot, warnings, mcp: mcpCommands() };
  } catch (err) {
    err.message +=
      `\nThe watchdog will not restart the server while ${p.hold} exists. ` +
      'Remove it once the database is known to be good.';
    throw err;
  } finally {
    releaseLock(root);
  }
}

if (isMain(import.meta.url)) {
  const root = process.env.PRISM_ROOT || join(homedir(), 'prism');
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > -1 ? process.argv[i + 1] : undefined;
  };
  const { cutoverEffects } = await import('./effects.js');
  try {
    const r = await cutover({
      root,
      snapshotPath: arg('--snapshot'),
      allowOld: process.argv.includes('--allow-old'),
      dryRun: process.argv.includes('--dry-run'),
      fx: cutoverEffects(root),
      log: console.log,
    });
    for (const w of r.warnings) console.warn(`WARNING: ${w}`);
    if (r.dryRun) {
      console.log(`Preconditions pass. A real run would:\n${r.steps.map((s) => `  - ${s}`).join('\n')}`);
    } else {
      console.log(
        '\nThe mini is now master. The laptop copy is disposable dev data: do not run db:backup there again.\n' +
          `\nOn the mini:\n  ${r.mcp.mini}\n\nOn the laptop:\n  ${r.mcp.laptop}\n`,
      );
    }
  } catch (err) {
    console.error(err.message);
    for (const w of err.warnings ?? []) console.warn(`WARNING: ${w}`);
    process.exitCode = 1;
  }
}
