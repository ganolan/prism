import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watcherProblem } from './install.js';

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'prism-install-'));
  mkdirSync(join(root, 'releases', 'r1', 'scripts', 'deploy'), { recursive: true });
  symlinkSync(join('releases', 'r1'), join(root, 'current'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// The deploy agent runs current/scripts/deploy/watch.js. Installing it before
// the live release contains that file starts a watcher that exits at once —
// and launchd, on demand only, never retries it.
describe('watcherProblem', () => {
  it('refuses while the live release predates the watcher', () => {
    expect(watcherProblem(root)).toMatch(/deploy this commit first/i);
  });

  it('is satisfied once the live release has watch.js', () => {
    writeFileSync(join(root, 'releases', 'r1', 'scripts', 'deploy', 'watch.js'), '');
    expect(watcherProblem(root)).toBe(null);
  });
});
