import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { snapshotName, listSnapshots, prune, backup, DEFAULT_KEEP } from './db-backup.js';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prism-backup-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const touch = (name) => writeFileSync(join(dir, name), 'x');

describe('snapshotName', () => {
  it('encodes the instant in a lexicographically sortable name', () => {
    const name = snapshotName(new Date('2026-09-22T13:30:00.000Z'));
    expect(name).toBe('students-20260922T133000Z.db');
  });

  it('sorts chronologically as plain strings', () => {
    const early = snapshotName(new Date('2026-01-02T03:04:05Z'));
    const late = snapshotName(new Date('2026-11-12T03:04:05Z'));
    expect([late, early].sort()).toEqual([early, late]);
  });
});

describe('listSnapshots', () => {
  it('returns newest first and ignores unrelated files', () => {
    touch('students-20260101T000000Z.db');
    touch('students-20260301T000000Z.db');
    touch('students-20260201T000000Z.db');
    touch('notes.txt');
    touch('students.db');

    expect(listSnapshots(dir)).toEqual([
      'students-20260301T000000Z.db',
      'students-20260201T000000Z.db',
      'students-20260101T000000Z.db',
    ]);
  });

  it('returns empty for a missing directory rather than throwing', () => {
    expect(listSnapshots(join(dir, 'nope'))).toEqual([]);
  });
});

describe('prune', () => {
  it('keeps the newest N and deletes the rest', () => {
    for (const d of ['0101', '0201', '0301', '0401']) touch(`students-2026${d}T000000Z.db`);

    const removed = prune(dir, 2);

    expect(removed.sort()).toEqual([
      'students-20260101T000000Z.db',
      'students-20260201T000000Z.db',
    ]);
    expect(listSnapshots(dir)).toEqual([
      'students-20260401T000000Z.db',
      'students-20260301T000000Z.db',
    ]);
  });

  it('never deletes unrelated files', () => {
    touch('students-20260101T000000Z.db');
    touch('important.db');
    prune(dir, 1);
    expect(existsSync(join(dir, 'important.db'))).toBe(true);
  });

  it('rejects keep < 1 so a typo cannot wipe every snapshot', () => {
    expect(() => prune(dir, 0)).toThrow(/keep must be >= 1/);
  });
});

describe('backup', () => {
  const makeDb = (path, rows) => {
    const db = new Database(path);
    db.exec('CREATE TABLE students (id INTEGER PRIMARY KEY, name TEXT)');
    const insert = db.prepare('INSERT INTO students (id, name) VALUES (?, ?)');
    rows.forEach(([id, name]) => insert.run(id, name));
    db.close();
  };

  it('writes a readable snapshot containing the source data', async () => {
    const dbPath = join(dir, 'live.db');
    makeDb(dbPath, [[1, 'Ada'], [2, 'Grace']]);
    const destDir = join(dir, 'out');

    const { dest, bytes } = await backup({ dbPath, destDir });

    expect(bytes).toBeGreaterThan(0);
    const restored = new Database(dest, { readonly: true });
    const names = restored.prepare('SELECT name FROM students ORDER BY id').all();
    restored.close();
    expect(names).toEqual([{ name: 'Ada' }, { name: 'Grace' }]);
  });

  it('snapshots a database left in WAL mode', async () => {
    const dbPath = join(dir, 'wal.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE t (v TEXT)');
    db.prepare('INSERT INTO t (v) VALUES (?)').run('written-in-wal');
    // Deliberately left open: the live server holds the DB open the same way.

    const { dest } = await backup({ dbPath, destDir: join(dir, 'out') });
    db.close();

    const restored = new Database(dest, { readonly: true });
    expect(restored.prepare('SELECT v FROM t').get()).toEqual({ v: 'written-in-wal' });
    restored.close();
  });

  it('prunes old snapshots as part of the run', async () => {
    const dbPath = join(dir, 'live.db');
    makeDb(dbPath, [[1, 'Ada']]);
    const destDir = join(dir, 'out');

    for (let i = 1; i <= 3; i++) {
      await backup({ dbPath, destDir, keep: 2, now: new Date(`2026-0${i}-01T00:00:00Z`) });
    }

    expect(listSnapshots(destDir)).toEqual([
      'students-20260301T000000Z.db',
      'students-20260201T000000Z.db',
    ]);
  });

  it('fails with actionable guidance when no destination is configured', async () => {
    await expect(backup({ dbPath: join(dir, 'x.db'), destDir: undefined })).rejects.toThrow(
      /PRISM_BACKUP_DIR/,
    );
  });

  it('defaults to keeping ten snapshots', () => {
    expect(DEFAULT_KEEP).toBe(10);
  });
});
