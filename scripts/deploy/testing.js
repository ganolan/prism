/**
 * Test-only fixture: a throwaway `origin` repo, a prism root whose repo/ is a
 * clone of it, and scriptable effects. Real git does the fetching and
 * exporting; CI, npm, launchd and the health check are stand-ins.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentRelease, paths } from './lib.js';
import { exportTree, fetchMain } from './effects.js';

export const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=Prism Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

export function makeFixture() {
  const tmp = mkdtempSync(join(tmpdir(), 'prism-deploy-'));
  const origin = join(tmp, 'origin');
  mkdirSync(origin);
  git(origin, 'init', '-q', '-b', 'main');

  const root = join(tmp, 'prism');
  const p = paths(root);

  const f = {
    tmp, origin, root, p,
    ci: 'success',
    buildFails: false,
    healthy: () => true,
    calls: [],
    logs: [],
    clock: Date.parse('2026-09-23T06:00:00Z'),

    commit(message) {
      writeFileSync(join(origin, 'CHANGELOG'), `${message}\n`, { flag: 'a' });
      git(origin, 'add', '-A');
      git(origin, 'commit', '-q', '-m', message);
      return git(origin, 'rev-parse', 'HEAD');
    },
    now: () => new Date((f.clock += 60_000)),
    log: (message) => f.logs.push(message),
    count: (kind) => f.calls.filter(([k]) => k === kind).length,
    fx: () => ({
      fetchMain: () => fetchMain(p.repo),
      ciStatus: (sha) => {
        f.calls.push(['ci', sha]);
        return f.ci;
      },
      exportTree: (sha, dest) => exportTree(p.repo, sha, dest),
      install: (dir) => {
        f.calls.push(['install', dir]);
        if (f.buildFails) throw new Error('npm ci exploded');
        writeFileSync(join(dir, '.installed'), '');
      },
      restart: () => f.calls.push(['restart', currentRelease(root)]),
      healthCheck: async (sha) => {
        f.calls.push(['health', sha]);
        return f.healthy(sha);
      },
    }),
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };

  writeFileSync(join(origin, 'package.json'), '{"name":"fixture"}\n');
  f.commit('initial');
  for (const dir of [p.releases, p.data, p.logs]) mkdirSync(dir, { recursive: true });
  writeFileSync(p.env, 'SCHOOLOGY_CONSUMER_KEY=fixture\n');
  git(tmp, 'clone', '-q', origin, p.repo);
  return f;
}
