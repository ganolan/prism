import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sessionDir,
  sessionStateFile,
  ensureSessionDir,
  SESSION_DIR_NAME,
  STATE_FILE_NAME,
} from './sessionPaths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'prism-session-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('sessionDir', () => {
  it('defaults to .playwright-session under the working directory', () => {
    expect(sessionDir({})).toBe(join(process.cwd(), SESSION_DIR_NAME));
  });

  it('treats an empty or whitespace override as unset', () => {
    expect(sessionDir({ PRISM_SESSION_DIR: '' })).toBe(join(process.cwd(), SESSION_DIR_NAME));
    expect(sessionDir({ PRISM_SESSION_DIR: '  ' })).toBe(join(process.cwd(), SESSION_DIR_NAME));
  });

  it('uses PRISM_SESSION_DIR verbatim when set, so a release swap cannot move it', () => {
    expect(sessionDir({ PRISM_SESSION_DIR: '/Users/gnolan/prism/data/.playwright-session' }))
      .toBe('/Users/gnolan/prism/data/.playwright-session');
  });
});

describe('sessionStateFile', () => {
  it('is storage-state.json inside the session directory', () => {
    expect(sessionStateFile({ PRISM_SESSION_DIR: '/tmp/sess' })).toBe(join('/tmp/sess', STATE_FILE_NAME));
    expect(STATE_FILE_NAME).toBe('storage-state.json');
  });
});

// Review Focus 4: on the server the first mastery:login runs against an empty
// ~/prism/data/ — the whole path has to be created, not just the leaf.
describe('ensureSessionDir', () => {
  it('creates the directory including missing parents', () => {
    const nested = join(tmp, 'data', 'nested', '.playwright-session');
    expect(existsSync(nested)).toBe(false);
    expect(ensureSessionDir({ PRISM_SESSION_DIR: nested })).toBe(nested);
    expect(existsSync(nested)).toBe(true);
  });

  it('is a no-op when the directory already exists', () => {
    const dir = join(tmp, '.playwright-session');
    ensureSessionDir({ PRISM_SESSION_DIR: dir });
    expect(() => ensureSessionDir({ PRISM_SESSION_DIR: dir })).not.toThrow();
    expect(existsSync(dir)).toBe(true);
  });
});

// A sixth service that hardcodes the path would break on the server in exactly
// the way this task exists to fix, and would do it silently.
describe('no service hardcodes the session directory', () => {
  it('every server/services/*.js goes through sessionPaths', () => {
    const dir = join(__dirname, '..', 'services');
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
      .filter((f) => readFileSync(join(dir, f), 'utf8').includes(SESSION_DIR_NAME));
    expect(offenders).toEqual([]);
  });
});
