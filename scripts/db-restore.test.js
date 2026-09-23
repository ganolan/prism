import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  copyFileSync,
  utimesSync,
  statSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { removeSidecars, safetyCopy, restore, newestMtime, SIDECAR_SUFFIXES } from './db-restore.js';

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

// ---- Findings from the whole-branch review of this change ----

describe('a restore that cannot complete leaves the database alone', () => {
  it('does not remove the live WAL until the snapshot has been read', async () => {
    mkdirSync(snapDir, { recursive: true });
    // A snapshot that passes listSnapshots but cannot be copied. In the field
    // this is a dehydrated OneDrive placeholder, an unreadable file, or ENOSPC
    // part-way through — PRISM_BACKUP_DIR is documented as a CloudStorage path.
    mkdirSync(join(snapDir, 'students-20260301T000000Z.db'));
    makeTrio(dbPath, ['committed-only-in-wal']);

    await expect(restore({ dbPath, srcDir: snapDir, force: true })).rejects.toThrow();

    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    expect(readRows(dbPath)).toEqual(['committed-only-in-wal']);
  });

  it('names the safety copy on the error, so a failure never hides it', async () => {
    mkdirSync(snapDir, { recursive: true });
    mkdirSync(join(snapDir, 'students-20260301T000000Z.db'));
    makeTrio(dbPath, ['local-row']);

    const err = await restore({ dbPath, srcDir: snapDir, force: true }).catch((e) => e);

    expect(err.safety).toMatch(/\.before-restore-/);
    expect(readRows(err.safety)).toEqual(['local-row']);
  });

  it('leaves no half-written incoming file behind', async () => {
    mkdirSync(snapDir, { recursive: true });
    mkdirSync(join(snapDir, 'students-20260301T000000Z.db'));
    makeTrio(dbPath, ['local-row']);

    await restore({ dbPath, srcDir: snapDir, force: true }).catch(() => {});

    expect(existsSync(`${dbPath}.restore-incoming`)).toBe(false);
  });
});

// db:restore is what you reach for *because* the database is broken. Opening it
// with SQLite to take the safety copy made a corrupt database refuse to restore.
describe('restoring over a corrupt database', () => {
  it('completes, falling back to a raw byte copy for the safety copy', async () => {
    writeSnapshot('students-20260301T000000Z.db', ['snapshot-row']);
    writeFileSync(dbPath, 'this is not a database at all');
    writeFileSync(`${dbPath}-wal`, 'garbage wal');

    const result = await restore({ dbPath, srcDir: snapDir, force: true });

    // Sidecars first: readRows() opens the database, and any WAL-mode open
    // re-creates -wal/-shm, which would mask whether the restore removed them.
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(result.safetyMode).toBe('raw');
    expect(readFileSync(result.safety, 'utf8')).toBe('this is not a database at all');
    expect(readRows(dbPath)).toEqual(['snapshot-row']);
  });

  it('keeps the corrupt database sidecars with the raw safety copy', async () => {
    writeSnapshot('students-20260301T000000Z.db', ['snapshot-row']);
    writeFileSync(dbPath, 'not a database');
    writeFileSync(`${dbPath}-wal`, 'garbage wal');

    const result = await restore({ dbPath, srcDir: snapDir, force: true });

    expect(readFileSync(`${result.safety}-wal`, 'utf8')).toBe('garbage wal');
  });
});

// A WAL-mode database's main file does not move while writes land in the -wal,
// so statting it alone reports an actively-written database as stale — the
// guard passed exactly when the local work was newest.
describe('newestMtime', () => {
  it('reports the newest of the database and its sidecars', () => {
    writeFileSync(dbPath, 'db');
    writeFileSync(`${dbPath}-wal`, 'wal');
    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(dbPath, old, old);

    expect(newestMtime(dbPath)).toBe(statSync(`${dbPath}-wal`).mtimeMs);
  });

  it('is 0 when there is no database', () => {
    expect(newestMtime(dbPath)).toBe(0);
  });
});

describe('the newer-than-snapshot guard', () => {
  it('sees work that lives only in the WAL', async () => {
    const snap = writeSnapshot('students-20260301T000000Z.db', ['snapshot-row']);
    writeFileSync(dbPath, 'db');
    writeFileSync(`${dbPath}-wal`, 'wal');
    // Main file older than the snapshot, WAL newer — the shape of a database
    // being actively written by a running Prism server.
    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(dbPath, old, old);
    utimesSync(snap, new Date('2021-01-01T00:00:00Z'), new Date('2021-01-01T00:00:00Z'));

    await expect(restore({ dbPath, srcDir: snapDir })).rejects.toThrow(/Refusing to restore/);
  });
});

describe('restoring a named snapshot', () => {
  it('uses the file it is given, not the newest in the folder', async () => {
    const chosen = writeSnapshot('students-20260101T000000Z.db', ['chosen']);
    writeSnapshot('students-20260301T000000Z.db', ['newer']);

    const result = await restore({ dbPath, snapshotFile: chosen, force: true });

    expect(result.snapshot).toBe('students-20260101T000000Z.db');
    expect(readRows(dbPath)).toEqual(['chosen']);
  });

  it('says so when the file does not exist', async () => {
    await expect(restore({ dbPath, snapshotFile: join(dir, 'nope.db'), force: true })).rejects.toThrow(/Snapshot not found/);
  });
});
