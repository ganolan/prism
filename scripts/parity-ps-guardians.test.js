import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { isProdDb } from './parity-ps-guardians.js';

// The guard that stops the live parity run from writing to prod's database.
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'parity-guardians-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('isProdDb', () => {
  it('follows symlinks to the production file', () => {
    const prod = join(dir, 'students.db');
    writeFileSync(prod, '');
    symlinkSync(prod, join(dir, 'link.db'));
    symlinkSync(dir, join(dir, 'linkdir'));
    expect(isProdDb(join(dir, 'link.db'), prod)).toBe(true);
    expect(isProdDb(join(dir, 'linkdir', 'students.db'), prod)).toBe(true);
    expect(isProdDb(prod, join(dir, 'linkdir', 'students.db'))).toBe(true);
  });

  it('a copy elsewhere is not prod', () => {
    const prod = join(dir, 'students.db');
    writeFileSync(prod, '');
    writeFileSync(join(dir, 'copy.db'), '');
    expect(isProdDb(join(dir, 'copy.db'), prod)).toBe(false);
  });

  it('compares the plain paths when a file does not exist', () => {
    const prod = join(dir, 'missing', 'students.db');
    expect(isProdDb(join(dir, 'missing', '..', 'missing', 'students.db'), prod)).toBe(true);
    expect(isProdDb(join(dir, 'other.db'), prod)).toBe(false);
  });
});
