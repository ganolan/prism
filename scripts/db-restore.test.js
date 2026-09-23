import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  copyFileSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { removeSidecars, safetyCopy, restore, SIDECAR_SUFFIXES } from './db-restore.js';

let dir, dbPath, snapDir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prism-restore-'));
  dbPath = join(dir, 'students.db');
  snapDir = join(dir, 'snapshots');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A WAL-mode database with `rows` inserted. Returns the OPEN connection. */
function makeDb(path, rows) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS t (v TEXT)');
  const insert = db.prepare('INSERT INTO t (v) VALUES (?)');
  for (const row of rows) insert.run(row);
  return db;
}

function readRows(path) {
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare('SELECT v FROM t ORDER BY v').all().map((r) => r.v);
  } finally {
    db.close();
  }
}

function writeSnapshot(name, rows) {
  mkdirSync(snapDir, { recursive: true });
  const path = join(snapDir, name);
  const db = makeDb(path, rows);
  db.close();
  return path;
}

/**
 * A database with genuine uncheckpointed -wal/-shm sidecars beside it and NO
 * open handle — the state left by an unclean shutdown, or by a live trio
 * copied between machines, which is the case #130 is about. SQLite truncates
 * the WAL when the last connection closes, so the only way to produce it is to
 * copy the trio out from under a live connection.
 */
function makeTrio(path, rows) {
  const source = join(dir, 'source.db');
  const db = makeDb(source, rows);
  copyFileSync(source, path);
  for (const suffix of ['-wal', '-shm']) copyFileSync(`${source}${suffix}`, `${path}${suffix}`);
  db.close();
  return path;
}

describe('removeSidecars', () => {
  it('deletes the WAL and SHM beside the database and reports what it removed', () => {
    writeFileSync(dbPath, 'db');
    writeFileSync(`${dbPath}-wal`, 'wal');
    writeFileSync(`${dbPath}-shm`, 'shm');

    expect(removeSidecars(dbPath).sort()).toEqual([`${dbPath}-shm`, `${dbPath}-wal`]);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    expect(existsSync(dbPath)).toBe(true);
    expect(SIDECAR_SUFFIXES).toEqual(['-wal', '-shm']);
  });

  // Review Focus 3: a fresh clone has neither database nor sidecars.
  it('is a no-op when nothing is there', () => {
    expect(removeSidecars(dbPath)).toEqual([]);
  });
});

describe('safetyCopy', () => {
  it('captures rows that exist only in the WAL', async () => {
    makeTrio(dbPath, ['a', 'b']);
    expect(existsSync(`${dbPath}-wal`)).toBe(true);

    const dest = join(dir, 'safety.db');
    await safetyCopy(dbPath, dest);

    expect(readRows(dest)).toEqual(['a', 'b']);
  });
});

describe('restore', () => {
  it('replaces the database with the newest snapshot', async () => {
    writeSnapshot('students-20260101T000000Z.db', ['old']);
    writeSnapshot('students-20260301T000000Z.db', ['new']);
    const live = makeDb(dbPath, ['local']);
    live.close();

    const result = await restore({ dbPath, srcDir: snapDir, force: true });

    expect(result.snapshot).toBe('students-20260301T000000Z.db');
    expect(readRows(dbPath)).toEqual(['new']);
  });

  // The #130 bug: the snapshot landed on the main file while the old WAL stayed
  // beside it, and SQLite would replay that foreign WAL over the restored data.
  it('leaves no foreign WAL beside the restored database', async () => {
    writeSnapshot('students-20260301T000000Z.db', ['snapshot-row']);
    makeTrio(dbPath, ['local-row']);
    expect(existsSync(`${dbPath}-wal`)).toBe(true);

    const result = await restore({ dbPath, srcDir: snapDir, force: true });

    expect(result.removedSidecars).toHaveLength(2);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    expect(readRows(dbPath)).toEqual(['snapshot-row']);
  });

  it('writes a safety copy that includes uncheckpointed local work', async () => {
    writeSnapshot('students-20260301T000000Z.db', ['snapshot-row']);
    makeTrio(dbPath, ['only-in-wal']);

    const result = await restore({ dbPath, srcDir: snapDir, force: true });

    expect(result.safety).toMatch(/\.before-restore-/);
    expect(readRows(result.safety)).toEqual(['only-in-wal']);
  });

  it('refuses when the local database is newer than the snapshot', async () => {
    const snap = writeSnapshot('students-20260301T000000Z.db', ['snapshot-row']);
    const live = makeDb(dbPath, ['local-row']);
    live.close();
    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(snap, old, old);

    await expect(restore({ dbPath, srcDir: snapDir })).rejects.toThrow(/Refusing to restore/);
    expect(readRows(dbPath)).toEqual(['local-row']);
  });

  it('proceeds past the guard when forced', async () => {
    const snap = writeSnapshot('students-20260301T000000Z.db', ['snapshot-row']);
    const live = makeDb(dbPath, ['local-row']);
    live.close();
    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(snap, old, old);

    await restore({ dbPath, srcDir: snapDir, force: true });
    expect(readRows(dbPath)).toEqual(['snapshot-row']);
  });

  // Review Focus 3 again, end to end: a clone that has never synced.
  it('restores onto a machine with no database yet', async () => {
    writeSnapshot('students-20260301T000000Z.db', ['snapshot-row']);

    const result = await restore({ dbPath, srcDir: snapDir });

    expect(result.safety).toBe(null);
    expect(readRows(dbPath)).toEqual(['snapshot-row']);
  });

  it('explains itself when there is nowhere to restore from', async () => {
    await expect(restore({ dbPath, srcDir: '' })).rejects.toThrow(/PRISM_BACKUP_DIR/);
    await expect(restore({ dbPath, srcDir: snapDir })).rejects.toThrow(/npm run db:backup/);
  });
});
