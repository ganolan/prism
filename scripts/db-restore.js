#!/usr/bin/env node
/**
 * Restore the newest snapshot from PRISM_BACKUP_DIR over the local database.
 *
 * Refuses to clobber a local DB that is newer than the snapshot unless --force
 * is passed, so pulling on a second machine cannot silently discard work done
 * there. Always writes a safety copy of the current DB first.
 */
import { copyFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { listSnapshots, snapshotName } from './db-backup.js';

config();

const dbPath = process.env.DB_PATH || 'server/db/students.db';
const srcDir = process.env.PRISM_BACKUP_DIR;
const force = process.argv.includes('--force');

if (!srcDir) {
  console.error('Set PRISM_BACKUP_DIR in .env first.');
  process.exit(1);
}

const [newest] = listSnapshots(srcDir);
if (!newest) {
  console.error(`No snapshots found in ${srcDir}. Run: npm run db:backup`);
  process.exit(1);
}

const src = join(srcDir, newest);

if (existsSync(dbPath) && !force) {
  const localMtime = statSync(dbPath).mtime;
  const snapMtime = statSync(src).mtime;
  if (localMtime > snapMtime) {
    console.error(
      `Refusing to restore: local DB (${localMtime.toISOString()}) is newer than\n` +
        `the snapshot (${snapMtime.toISOString()}).\n` +
        `Back up this machine first (npm run db:backup), or re-run with --force.`,
    );
    process.exit(1);
  }
}

if (existsSync(dbPath)) {
  const safety = `${dbPath}.before-restore-${snapshotName().replace(/^students-|\.db$/g, '')}`;
  copyFileSync(dbPath, safety);
  console.log(`Safety copy of current DB: ${safety}`);
}

copyFileSync(src, dbPath);
console.log(`Restored ${newest} -> ${dbPath}`);
