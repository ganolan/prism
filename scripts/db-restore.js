#!/usr/bin/env node
/**
 * Restore the newest snapshot from PRISM_BACKUP_DIR over the local database.
 *
 * Every hazard here is silent, which is why the ordering below is deliberate
 * rather than incidental (#130):
 *
 * 1. The database being replaced may have -wal/-shm sidecars. Copying a
 *    snapshot over the main file alone leaves them in place, and SQLite will
 *    replay a WAL belonging to a *different* database over the restored file.
 *    The documented outcome is corruption. The mtime guard does not cover it:
 *    a stale older local DB passes the guard and keeps its foreign WAL.
 * 2. The safety copy has to be taken with SQLite's backup API. `copyFileSync`
 *    captures the main file only, dropping whatever is still in the WAL — a
 *    safety copy that loses the work it exists to protect.
 * 3. Nothing destructive happens until the snapshot has been read in full. The
 *    snapshot normally lives in cloud storage (PRISM_BACKUP_DIR), where a
 *    dehydrated placeholder or a disconnected network fails the read halfway;
 *    a restore that cannot finish must leave the database exactly as it was.
 * 4. The safety copy is taken even when the local database will not open. A
 *    restore is what you reach for *because* the database is broken, so
 *    refusing to run on a corrupt one fails in the only case that matters.
 *
 * The mtime guard stays on `db:restore` (a genuine two-machine handoff) and is
 * skipped by `db:refresh`, where the local database is disposable by design.
 */
import Database from 'better-sqlite3';
import { copyFileSync, existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
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

/**
 * Newest mtime across the database and its sidecars, in ms; 0 if absent.
 *
 * A WAL-mode database's main file does not move while writes land in the -wal,
 * so statting it alone reports an actively-written database as stale — and the
 * guard that exists to protect unsynced local work would wave it through
 * exactly when that work was newest.
 */
export function newestMtime(dbPath) {
  let newest = 0;
  for (const path of [dbPath, ...SIDECAR_SUFFIXES.map((s) => `${dbPath}${s}`)]) {
    if (existsSync(path)) newest = Math.max(newest, statSync(path).mtimeMs);
  }
  return newest;
}

/**
 * Copy `dbPath` to `dest` as safely as that database allows.
 *
 * Normally that is SQLite's backup API, which produces a single consistent
 * file including anything still in the WAL. When the database will not open at
 * all, fall back to a raw byte copy of the trio: an unreadable copy of an
 * unreadable database still beats refusing to restore, which would strand the
 * user in the exact situation the tool exists for.
 *
 * Returns `{ dest, mode: 'consistent' | 'raw', reason? }`.
 */
export async function safetyCopy(dbPath, dest) {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      await db.backup(dest);
    } finally {
      db.close();
    }
    return { dest, mode: 'consistent' };
  } catch (err) {
    copyFileSync(dbPath, dest);
    for (const suffix of SIDECAR_SUFFIXES) {
      const from = `${dbPath}${suffix}`;
      if (existsSync(from)) copyFileSync(from, `${dest}${suffix}`);
    }
    return { dest, mode: 'raw', reason: err.message };
  }
}

export async function restore({ dbPath, srcDir, snapshotFile, force = false, now = new Date(), onSafetyCopy }) {
  let newest;
  let src;
  if (snapshotFile) {
    // Named explicitly — cutover must restore the snapshot taken at cutover,
    // never whatever happens to be newest in a synced folder.
    if (!existsSync(snapshotFile)) throw new Error(`Snapshot not found: ${snapshotFile}`);
    src = snapshotFile;
    newest = basename(snapshotFile);
  } else {
    if (!srcDir) throw new Error('Set PRISM_BACKUP_DIR in .env first.');
    [newest] = listSnapshots(srcDir);
    if (!newest) throw new Error(`No snapshots found in ${srcDir}. Run: npm run db:backup`);
    src = join(srcDir, newest);
  }

  if (existsSync(dbPath) && !force) {
    const localMs = newestMtime(dbPath);
    const snapMs = statSync(src).mtimeMs;
    if (localMs > snapMs) {
      throw new Error(
        `Refusing to restore: local DB (${new Date(localMs).toISOString()}) is newer than\n` +
          `the snapshot (${new Date(snapMs).toISOString()}).\n` +
          `Back up this machine first (npm run db:backup), or re-run with --force.\n` +
          `On a dev clone whose data is disposable, use: npm run db:refresh`,
      );
    }
  }

  // The safety copy comes first, while the old WAL is still intact, so it
  // captures everything — and it is announced immediately, because the moment
  // it matters most is the moment a later step fails.
  let safety = null;
  let safetyMode = null;
  if (existsSync(dbPath)) {
    safety = `${dbPath}.before-restore-${snapshotName(now).replace(/^students-|\.db$/g, '')}`;
    const copied = await safetyCopy(dbPath, safety);
    safetyMode = copied.mode;
    onSafetyCopy?.(copied);
  }

  // Read the snapshot in full before anything destructive happens: a failure
  // here must leave the live trio exactly as it was.
  const incoming = `${dbPath}.restore-incoming`;
  try {
    copyFileSync(src, incoming);
  } catch (err) {
    rmSync(incoming, { force: true });
    err.safety = safety;
    throw err;
  }

  // Now the swap. The sidecars belong to the database being replaced, so they
  // go before the rename; the rename itself is atomic on one filesystem.
  const removedSidecars = removeSidecars(dbPath);
  renameSync(incoming, dbPath);

  return { snapshot: newest, src, dbPath, safety, safetyMode, removedSidecars };
}

// ---- CLI ----
import { isMain } from '../server/lib/isMain.js';

if (isMain(import.meta.url)) {
  const { config } = await import('dotenv');
  config();

  const dbPath = process.env.DB_PATH || 'server/db/students.db';
  const srcDir = process.env.PRISM_BACKUP_DIR;
  const force = process.argv.includes('--force');

  const announce = ({ dest, mode, reason }) => {
    console.log(`Safety copy of current DB: ${dest}`);
    if (mode === 'raw') {
      console.warn(
        `  WARNING: the current database could not be opened (${reason}), so that\n` +
          '  safety copy is a raw byte copy of a damaged file, not a consistent snapshot.',
      );
    }
  };

  try {
    const result = await restore({ dbPath, srcDir, force, onSafetyCopy: announce });
    for (const path of result.removedSidecars) console.log(`Removed stale sidecar: ${path}`);
    console.log(`Restored ${result.snapshot} -> ${result.dbPath}`);
  } catch (err) {
    console.error(err.message);
    if (err.safety) {
      console.error(`Your database was NOT modified. The safety copy is at: ${err.safety}`);
    }
    process.exit(1);
  }
}
