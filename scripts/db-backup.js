#!/usr/bin/env node
/**
 * Consistent SQLite snapshots for cross-machine access.
 *
 * The live DB runs in WAL mode, so copying students.db with `cp` (or letting a
 * file syncer such as OneDrive sync it in place) can capture a torn write or
 * produce conflict copies. better-sqlite3's backup API takes a consistent
 * snapshot of a live database instead, which is safe to hand to a file syncer.
 *
 * Destination comes from PRISM_BACKUP_DIR (see .env.example).
 */
import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const SNAPSHOT_RE = /^students-(\d{8}T\d{6}Z)\.db$/;
export const DEFAULT_KEEP = 10;

/** Snapshot filename for a given instant, e.g. students-20260922T133000Z.db */
export function snapshotName(date = new Date()) {
  const iso = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return `students-${iso}.db`;
}

/** Snapshot files in `dir`, newest first (names sort lexicographically by time). */
export function listSnapshots(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => SNAPSHOT_RE.test(n)).sort().reverse();
}

/** Delete all but the newest `keep` snapshots. Returns the names removed. */
export function prune(dir, keep = DEFAULT_KEEP) {
  if (keep < 1) throw new Error('keep must be >= 1');
  const stale = listSnapshots(dir).slice(keep);
  for (const name of stale) unlinkSync(join(dir, name));
  return stale;
}

/** Write a consistent snapshot of `dbPath` into `destDir`, then prune. */
export async function backup({ dbPath, destDir, keep = DEFAULT_KEEP, now = new Date() }) {
  if (!destDir) {
    throw new Error(
      'No backup destination. Set PRISM_BACKUP_DIR in .env to a synced folder, ' +
        'e.g. PRISM_BACKUP_DIR=/Users/you/Library/CloudStorage/OneDrive-.../_prism-data',
    );
  }
  mkdirSync(destDir, { recursive: true });
  const name = snapshotName(now);
  const dest = join(destDir, name);

  const db = new Database(dbPath, { readonly: true });
  try {
    await db.backup(dest);
  } finally {
    db.close();
  }

  const pruned = prune(destDir, keep);
  return { dest, name, bytes: statSync(dest).size, pruned };
}

// ---- CLI ----
import { pathToFileURL } from 'node:url';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { config } = await import('dotenv');
  config();
  const dbPath = process.env.DB_PATH || 'server/db/students.db';
  const destDir = process.env.PRISM_BACKUP_DIR;
  const keep = Number(process.env.PRISM_BACKUP_KEEP || DEFAULT_KEEP);

  try {
    const { dest, bytes, pruned } = await backup({ dbPath, destDir, keep });
    const mb = (bytes / 1024 / 1024).toFixed(1);
    console.log(`Snapshot written: ${dest} (${mb} MB)`);
    if (pruned.length) console.log(`Pruned ${pruned.length} old snapshot(s), keeping ${keep}.`);
  } catch (err) {
    console.error(`Backup failed: ${err.message}`);
    process.exit(1);
  }
}
