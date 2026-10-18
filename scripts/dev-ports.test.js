import { describe, it, expect } from 'vitest';
import { classifyListeners, preflightMessage, parseListeners, parseCwds, stopPlan, parsePs, watchers } from './dev-ports.js';

const REPO = '/Users/t/repos/prism';
const PROD = { pid: 15851, port: 3001, cwd: '/Users/t/prism/releases/20260927T144339Z-4cdf4e5', command: 'node' };

describe('classifyListeners', () => {
  it('owns listeners running from this clone, including client/ (Vite)', () => {
    const api = { pid: 1, port: 3001, cwd: REPO, command: 'node' };
    const vite = { pid: 2, port: 5173, cwd: `${REPO}/client`, command: 'node' };
    expect(classifyListeners([api, vite], REPO)).toEqual({ owned: [api, vite], foreign: [] });
  });

  it('treats prod (a release dir outside the clone) as foreign — never ours to kill', () => {
    expect(classifyListeners([PROD], REPO)).toEqual({ owned: [], foreign: [PROD] });
  });

  it('a sibling path that merely starts with the repo path is foreign', () => {
    const sibling = { pid: 3, port: 3001, cwd: `${REPO}-old`, command: 'node' };
    expect(classifyListeners([sibling], REPO).foreign).toEqual([sibling]);
  });

  it('an unknown cwd is foreign (fail safe)', () => {
    const unknown = { pid: 4, port: 3001, cwd: null, command: 'node' };
    expect(classifyListeners([unknown], REPO).foreign).toEqual([unknown]);
  });
});

describe('preflightMessage', () => {
  it('null when the API port is free', () => {
    expect(preflightMessage({ port: 3001, owned: [], foreign: [], portFromEnv: false })).toBeNull();
  });

  it('refuses when another install (prod) holds the port, pointing at PORT=3002', () => {
    const msg = preflightMessage({ port: 3001, owned: [], foreign: [PROD], portFromEnv: false });
    expect(msg).toMatch(/NOT this clone/);
    expect(msg).toMatch(/PORT=3002 npm run dev/);
    expect(msg).toMatch(/do not kill/i);
  });

  it('points at dev:stop when this clone\'s own stale server holds the port', () => {
    const msg = preflightMessage({ port: 3001, owned: [{ ...PROD, cwd: REPO }], foreign: [], portFromEnv: false });
    expect(msg).toMatch(/npm run dev:stop/);
  });
});

describe('classifyListeners with nested checkouts', () => {
  // Worktrees live inside the main clone (.claude/worktrees/<name>), so a path
  // prefix alone would let `dev:stop` in the main clone kill a worktree's server.
  const WT = `${REPO}/.claude/worktrees/wt-a`;
  const isCheckoutRoot = (dir) => dir === WT;

  it('a listener inside a nested worktree is foreign to the outer clone', () => {
    const wtVite = { pid: 5, port: 5174, cwd: `${WT}/client`, command: 'node' };
    const own = { pid: 6, port: 5173, cwd: `${REPO}/client`, command: 'node' };
    expect(classifyListeners([wtVite, own], REPO, { isCheckoutRoot }))
      .toEqual({ owned: [own], foreign: [wtVite] });
  });

  it('the worktree still owns its own listeners', () => {
    const wtVite = { pid: 5, port: 5174, cwd: `${WT}/client`, command: 'node' };
    expect(classifyListeners([wtVite], WT, { isCheckoutRoot }).owned).toEqual([wtVite]);
  });
});

describe('parseListeners', () => {
  it('reads pid, command and every listening port from lsof -F output', () => {
    const out = ['p101', 'cnode', 'f20', 'n127.0.0.1:3012', 'f21', 'n[::1]:3012',
      'p202', 'cnode', 'f30', 'n*:5174', 'p303', 'cSpotify', 'f9', 'n127.0.0.1:7768', ''].join('\n');
    expect(parseListeners(out)).toEqual([
      { pid: 101, command: 'node', ports: [3012] },
      { pid: 202, command: 'node', ports: [5174] },
      { pid: 303, command: 'Spotify', ports: [7768] },
    ]);
  });
});

describe('parseCwds', () => {
  it('maps each pid to its working directory', () => {
    const out = ['p101', 'fcwd', 'n/Users/t/repos/prism', 'p202', 'fcwd', 'n/Users/t/repos/prism/client', ''].join('\n');
    expect(parseCwds(out)).toEqual(new Map([[101, '/Users/t/repos/prism'], [202, '/Users/t/repos/prism/client']]));
  });
});

describe('stopPlan', () => {
  const listeners = [
    { pid: 1, command: 'node', ports: [3012], cwd: REPO },
    { pid: 2, command: 'node', ports: [5174], cwd: `${REPO}/client` }, // Vite on a non-default port
    { ...PROD, ports: [3001] },
    { pid: 9, command: 'Spotify', ports: [7768], cwd: '/' },
  ];

  it('stops this clone\'s listeners on any port, Vite included', () => {
    expect(stopPlan(listeners, REPO).stop.map((l) => l.pid)).toEqual([1, 2]);
  });

  it('reports foreign node listeners (prod, other clones) and ignores unrelated apps', () => {
    expect(stopPlan(listeners, REPO).leave.map((l) => l.pid)).toEqual([PROD.pid]);
  });
});

describe('watchers', () => {
  // `npm run dev:server` is `node --watch server/index.js`: stopping only the
  // listening child (or a crashed API) leaves the watcher waiting to restart it
  // on the next edit.
  const procs = parsePs([
    '19952     1 npm run dev',
    '20015 19952 node /r/node_modules/.bin/concurrently npm run dev:server npm run dev:client',
    '20017 20015 npm run dev:server',
    '20137 20017 node --watch server/index.js',
    '20138 20137 /usr/local/bin/node server/index.js',
    '20536 20435 node /r/client/node_modules/.bin/vite',
    '',
  ].join('\n'));

  it('parses pid, ppid and args from ps -Ao pid=,ppid=,args=', () => {
    expect(procs[3]).toEqual({ pid: 20137, ppid: 20017, args: 'node --watch server/index.js' });
  });

  it('picks out node --watch processes only', () => {
    expect(watchers(procs).map((p) => p.pid)).toEqual([20137]);
  });

  it('ignores args that merely mention --watch', () => {
    expect(watchers(parsePs('1 0 grep -- --watch\n2 0 vitest --watch=false'))).toEqual([]);
  });
});
