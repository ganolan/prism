import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agents, installPlan, renderPlist, NODE_BIN } from './launchd.js';

const HOME = '/Users/gnolan';

const allStrings = (v) =>
  typeof v === 'string'
    ? [v]
    : Array.isArray(v)
      ? v.flatMap(allStrings)
      : v && typeof v === 'object'
        ? Object.values(v).flatMap(allStrings)
        : [];

describe('renderPlist', () => {
  it('renders a launchd property list, escaping XML', () => {
    const xml = renderPlist({ Label: 'a&b', Args: ['<x>'], N: 30, On: true, Env: { K: 'v' } });
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<!DOCTYPE plist/);
    expect(xml).toContain('<key>Label</key>');
    expect(xml).toContain('<string>a&amp;b</string>');
    expect(xml).toContain('<string>&lt;x&gt;</string>');
    expect(xml).toContain('<integer>30</integer>');
    expect(xml).toContain('<true/>');
    expect(xml).toMatch(/<key>Env<\/key>\s*<dict>\s*<key>K<\/key>\s*<string>v<\/string>/);
  });
});

describe('agents', () => {
  const a = agents({ home: HOME });

  it('uses only absolute paths — launchd does not expand ~', () => {
    for (const agent of Object.values(a)) {
      for (const s of allStrings(agent).filter((x) => x.includes('/'))) {
        // PATH is a colon-joined list of absolute directories.
        for (const part of s.split(':')) {
          expect(part.startsWith('/'), part).toBe(true);
          expect(part.includes('~'), part).toBe(false);
        }
      }
    }
  });

  it('runs node from the stable Homebrew link, not a versioned Cellar path', () => {
    expect(NODE_BIN).toBe('/usr/local/bin/node');
    expect(a.server.ProgramArguments[0]).toBe('/usr/local/bin/node');
  });

  it('keeps the server on loopback with everything stateful in ~/prism/data', () => {
    const env = a.server.EnvironmentVariables;
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.PORT).toBe('3001');
    expect(env.DB_PATH).toBe(`${HOME}/prism/data/students.db`);
    expect(env.PRISM_SESSION_DIR).toBe(`${HOME}/prism/data/.playwright-session`);
    expect(env.INBOX_DIR).toBe(`${HOME}/prism/data/inbox`);
    expect(a.server.WorkingDirectory).toBe(`${HOME}/prism/current`);
    expect(a.server.KeepAlive).toBe(true);
  });

  it('polls every 30 seconds from the live release', () => {
    expect(a.deploy.StartInterval).toBe(30);
    expect(a.deploy.ProgramArguments[1]).toBe(`${HOME}/prism/current/scripts/deploy/deploy.js`);
  });

  it('backs up nightly from the live release', () => {
    expect(a.backup.StartCalendarInterval).toEqual({ Hour: 2, Minute: 0 });
    expect(a.backup.EnvironmentVariables.DB_PATH).toBe(`${HOME}/prism/data/students.db`);
  });
});

// Review Focus 4.
describe('installPlan', () => {
  const plan = installPlan({ home: HOME });

  it('installs the server and deploy agents into LaunchAgents', () => {
    const agentsDir = `${HOME}/Library/LaunchAgents/`;
    expect(plan.files.map((f) => f.path)).toEqual(
      expect.arrayContaining([`${agentsDir}com.prism.server.plist`, `${agentsDir}com.prism.deploy.plist`]),
    );
  });

  it('stages the backup agent OUTSIDE LaunchAgents and never loads it before cutover', () => {
    const backup = plan.files.find((f) => f.path.endsWith('com.prism.backup.plist'));
    expect(backup.path).toBe(`${HOME}/prism/launchd/com.prism.backup.plist`);
    expect(plan.files.some((f) => f.path.includes('LaunchAgents') && f.path.includes('backup'))).toBe(false);
    expect(plan.reload).not.toContain('com.prism.backup');
  });
});

describe('plutil', () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'prism-plist-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it.skipIf(process.platform !== 'darwin')('accepts all three plists', () => {
    for (const f of installPlan({ home: HOME }).files) {
      const file = join(tmp, f.path.split('/').pop());
      writeFileSync(file, f.content);
      const res = spawnSync('plutil', ['-lint', file], { encoding: 'utf8' });
      expect(res.status, res.stdout + res.stderr).toBe(0);
    }
  });
});
