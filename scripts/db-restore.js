#!/usr/bin/env node
/**
 * Restore the newest snapshot from PRISM_BACKUP_DIR over the local database.
 *
 * Two WAL hazards this handles, both of which are silent (#130):
 *
 * 1. The database being replaced may have -wal/-shm sidecars. Copying a
 *    snapshot over the main file alone leaves them in place, and SQLite will
 *    replay a WAL belonging to a *different* database over the restored file.
 *    The documented outcome is corruption. The mtime guard does not cover it:
 *    a stale older local DB passes the guard and keeps its foreign WAL.
 * 2. The safety copy has to be taken with SQLite's backup API. `copyFileSync`
 *    captures the main file only, dropping whatever is still in the WAL — a
 *    safety copy that loses the work it exists to protect.
 *
 * The mtime guard stays on `db:restore` (a genuine two-machine handoff) and is
 * skipped by `db:refresh`, where the local database is disposable by design.
 */
import Database from 'better-sqlite3';
import { copyFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { listSnapshots, snapshotName } from './db-backup.js';

export const SIDECAR_SUFFIXES = ['-wal', '-shm'];

/** Delete the WAL/SHM sidecars beside `dbPath`. Returns the paths removed. */
export function removeSidecars(dbPath) {
  const removed = [];
  for (const suffix of SIDECAR_SUFFIXES) {
    const path = `${dbPath}${suffix}`;
    if (existsSync(path)) {
      rmSync(path);
      removed.push(path);
    }
  }
  return removed;
}

/** Consistent copy of a live WAL-mode database, via SQLite's backup API. */
export async function safetyCopy(dbPath, dest) {
  const db = new Database(dbPath, { readonly: true });
  try {
    await db.backup(dest);
  } finally {
    db.close();
  }
  return dest;
}

export async function restore({ dbPath, srcDir, force = false, now = new Date() }) {
  if (!srcDir) throw new Error('Set PRISM_BACKUP_DIR in .env first.');

  const [newest] = listSnapshots(srcDir);
  if (!newest) throw new Error(`No snapshots found in ${srcDir}. Run: npm run db:backup`);
  const src = join(srcDir, newest);

  if (existsSync(dbPath) && !force) {
    const localMtime = statSync(dbPath).mtime;
    const snapMtime = statSync(src).mtime;
    if (localMtime > snapMtime) {
      throw new Error(
        `Refusing to restore: local DB (${localMtime.toISOString()}) is newer than\n` +
          `the snapshot (${snapMtime.toISOString()}).\n` +
          `Back up this machine first (npm run db:backup), or re-run with --force.\n` +
          `On a dev clone whose data is disposable, use: npm run db:refresh`,
      );
    }
  }

  // Order matters. The safety copy is taken while the old WAL is still intact,
  // so it captures everything; only then do the sidecars go; only then does the
  // snapshot land, onto a file with no foreign WAL beside it.
  let safety = null;
  if (existsSync(dbPath)) {
    safety = `${dbPath}.before-restore-${snapshotName(now).replace(/^students-|\.db$/g, '')}`;
    await safetyCopy(dbPath, safety);
  }

  const removedSidecars = removeSidecars(dbPath);
  copyFileSync(src, dbPath);

  return { snapshot: newest, src, dbPath, safety, removedSidecars };
}

// ---- CLI ----
import { pathToFileURL } from 'node:url';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { config } = await import('dotenv');
  config();

  const dbPath = process.env.DB_PATH || 'server/db/students.db';
  const srcDir = process.env.PRISM_BACKUP_DIR;
  const force = process.argv.includes('--force');

  try {
    const result = await restore({ dbPath, srcDir, force });
    if (result.safety) console.log(`Safety copy of current DB: ${result.safety}`);
    for (const path of result.removedSidecars) console.log(`Removed stale sidecar: ${path}`);
    console.log(`Restored ${result.snapshot} -> ${result.dbPath}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
