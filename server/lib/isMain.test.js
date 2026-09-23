import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMain } from './isMain.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'prism-ismain-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** A script that reports whether isMain() thinks it is the entry point. */
function probe() {
  const real = join(tmp, 'releases', 'r1');
  mkdirSync(real, { recursive: true });
  const lib = pathToFileURL(join(__dirname, 'isMain.js')).href;
  writeFileSync(
    join(real, 'probe.mjs'),
    `import { isMain } from ${JSON.stringify(lib)};\nconsole.log(isMain(import.meta.url) ? 'main' : 'not-main');\n`,
  );
  symlinkSync(join('releases', 'r1'), join(tmp, 'current'));
  return { real: join(real, 'probe.mjs'), linked: join(tmp, 'current', 'probe.mjs') };
}

const runNode = (file) => spawnSync(process.execPath, [file], { encoding: 'utf8' }).stdout.trim();

describe('isMain', () => {
  it('is true when run by its real path', () => {
    expect(runNode(probe().real)).toBe('main');
  });

  // Review Focus 1 — how launchd starts every prod script.
  it('is true when run through a symlinked directory like ~/prism/current', () => {
    expect(runNode(probe().linked)).toBe('main');
  });

  it('is false for a module that is not the entry point', () => {
    expect(isMain(import.meta.url, join(tmp, 'something-else.js'))).toBe(false);
  });

  it('is false with no entry point at all', () => {
    expect(isMain(import.meta.url, undefined)).toBe(false);
  });
});

// The old guard is correct-looking and silently wrong; keep it from coming back.
describe('no CLI uses the symlink-blind entry guard', () => {
  it('has no `pathToFileURL(process.argv[1])` comparison left', () => {
    const files = ['scripts', 'mcp', join('scripts', 'deploy')]
      .flatMap((d) => {
        try {
          return readdirSync(join(REPO, d)).map((f) => join(REPO, d, f));
        } catch {
          return [];
        }
      })
      .filter((f) => /\.(m?js)$/.test(f) && !f.endsWith('.test.js') && statSync(f).isFile());
    const offenders = files.filter((f) => readFileSync(f, 'utf8').includes('pathToFileURL(process.argv[1])'));
    expect(offenders.map((f) => f.slice(REPO.length + 1))).toEqual([]);
  });
});
