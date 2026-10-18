#!/usr/bin/env node
// Dev-server port guard. Prod runs on the Mac mini at 127.0.0.1:3001 (launchd
// com.prism.server, cwd ~/prism/releases/<release>), and dev clones share that
// machine. A blanket `lsof -ti:3001 | xargs kill` therefore kills PROD, and a
// dev API that loses the port race leaves the dev UI proxying to prod.
//
//   node scripts/dev-ports.js check   (runs as `predev`) — refuse to start when
//        the API port is taken, naming who holds it and what to do instead.
//   node scripts/dev-ports.js stop    (`npm run dev:stop`) — kill every listener
//        (API, Vite, any port) whose working directory is inside THIS clone;
//        report the other node listeners (prod, other clones) and leave them.
//        Worktrees live inside the main clone (.claude/worktrees/<name>), so a
//        cwd inside a nested checkout belongs to that checkout, not this one.
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { isMain } from '../server/lib/isMain.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const hasGitEntry = (dir) => existsSync(join(dir, '.git'));

/**
 * Split listeners into those running from inside `repoRoot` and everyone else.
 * A cwd under a nested checkout (a directory below `repoRoot` with its own
 * `.git`, e.g. a worktree) is foreign.
 */
export function classifyListeners(listeners, repoRoot, { isCheckoutRoot = hasGitEntry } = {}) {
  const inside = (cwd) => {
    if (!cwd || !(cwd === repoRoot || cwd.startsWith(repoRoot + sep))) return false;
    for (let dir = cwd; dir !== repoRoot; dir = dirname(dir)) {
      if (isCheckoutRoot(dir)) return false;
    }
    return true;
  };
  return {
    owned: listeners.filter((l) => inside(l.cwd)),
    foreign: listeners.filter((l) => !inside(l.cwd)),
  };
}

const describe = (l) => `pid ${l.pid} (${l.command}, cwd ${l.cwd ?? 'unknown'})`;
const portsOf = (l) => (l.ports ?? [l.port]).map((p) => `:${p}`).join(', ');

/** Parse `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` into one entry per process. */
export function parseListeners(out) {
  const byPid = [];
  let cur = null;
  for (const line of out.split('\n')) {
    const tag = line[0];
    const val = line.slice(1);
    if (tag === 'p') byPid.push(cur = { pid: Number(val), command: '?', ports: [] });
    else if (tag === 'c' && cur) cur.command = val;
    else if (tag === 'n' && cur) {
      const port = Number(val.slice(val.lastIndexOf(':') + 1));
      if (port && !cur.ports.includes(port)) cur.ports.push(port);
    }
  }
  return byPid;
}

/** Parse `lsof -a -d cwd -p <pids> -Fpn` into pid → cwd. */
export function parseCwds(out) {
  const cwds = new Map();
  let pid = null;
  for (const line of out.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && pid != null) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

/** Parse `ps -Ao pid=,ppid=,args=`. */
export function parsePs(out) {
  return out.split('\n').map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map(([, pid, ppid, args]) => ({ pid: Number(pid), ppid: Number(ppid), args: args.trim() }));
}

/**
 * The `node --watch` processes (`npm run dev:server`). Stopping only the API
 * leaves its watcher alive, and it restarts the API on the next file edit; a
 * crashed API leaves the watcher waiting the same way.
 */
export function watchers(procs) {
  return procs.filter((p) => /^\S*node\s+--watch\b/.test(p.args));
}

/**
 * What `dev:stop` does: stop every listener from this clone, and name the
 * foreign node listeners it leaves (prod, other clones). Other apps are ignored.
 */
export function stopPlan(listeners, repoRoot, opts) {
  const { owned, foreign } = classifyListeners(listeners, repoRoot, opts);
  return { stop: owned, leave: foreign.filter((l) => l.command === 'node') };
}

/** Why `npm run dev` must not start, or null when the API port is free. */
export function preflightMessage({ port, owned, foreign, portFromEnv }) {
  if (foreign.length) {
    return [
      `Port ${port} is held by ${foreign.map(describe).join(', ')} — NOT this clone.`,
      `On the Mac mini that is prod (launchd com.prism.server). Do not kill it.`,
      portFromEnv
        ? `Pick a different free port: PORT=<port> npm run dev.`
        : `Run the dev copy on its own port instead: PORT=3002 npm run dev.`,
    ].join('\n');
  }
  if (owned.length) {
    return `Port ${port} is held by a stale dev server from this clone (${owned.map(describe).join(', ')}).\n` +
      `Stop it with: npm run dev:stop`;
  }
  return null;
}

function listenersOn(port) {
  let pids;
  try {
    pids = execFileSync('lsof', ['-ti', `:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
      .split('\n').filter(Boolean).map(Number);
  } catch {
    return []; // lsof exits 1 when nothing listens
  }
  return pids.map((pid) => {
    let cwd = null;
    let command = '?';
    try {
      const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fcn'], { encoding: 'utf8' });
      cwd = out.split('\n').find((l) => l.startsWith('n'))?.slice(1) || null;
      command = out.split('\n').find((l) => l.startsWith('c'))?.slice(1) || '?';
    } catch { /* process gone or not ours to inspect → cwd unknown → foreign */ }
    return { pid, port, cwd, command };
  });
}

function cwdsOf(pids) {
  if (!pids.length) return new Map();
  const args = ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn'];
  try {
    return parseCwds(execFileSync('lsof', args, { encoding: 'utf8' }));
  } catch (e) {
    return parseCwds(e.stdout ?? ''); // unreadable cwd → unknown → foreign
  }
}

/** Every TCP listener on the machine, with its working directory when readable. */
function allListeners() {
  let listeners;
  try {
    listeners = parseListeners(execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], { encoding: 'utf8' }));
  } catch (e) {
    listeners = parseListeners(e.stdout ?? ''); // lsof exits 1 if any process can't be read
  }
  const cwds = cwdsOf(listeners.map((l) => l.pid));
  return listeners.map((l) => ({ ...l, cwd: cwds.get(l.pid) ?? null }));
}

function main(mode) {
  const apiPort = Number(process.env.PORT) || 3001;
  if (mode === 'check') {
    const msg = preflightMessage({
      port: apiPort,
      ...classifyListeners(listenersOn(apiPort), REPO_ROOT),
      portFromEnv: !!process.env.PORT,
    });
    if (msg) {
      console.error(`\n✖ npm run dev aborted.\n${msg}\n`);
      process.exit(1);
    }
    return;
  }
  if (mode === 'stop') {
    const { stop, leave } = stopPlan(allListeners(), REPO_ROOT);
    // This clone's watchers go first, so none can restart the API.
    const found = watchers(parsePs(execFileSync('ps', ['-Ao', 'pid=,ppid=,args='], { encoding: 'utf8' })));
    const cwds = cwdsOf(found.map((w) => w.pid));
    const { owned: ownWatchers } = classifyListeners(found.map((w) => ({ ...w, cwd: cwds.get(w.pid) ?? null })), REPO_ROOT);
    for (const w of ownWatchers) {
      try { process.kill(w.pid, 'SIGTERM'); console.log(`stopped watcher pid ${w.pid} (${w.args})`); } catch { /* already gone */ }
    }
    for (const l of stop) {
      try { process.kill(l.pid, 'SIGTERM'); console.log(`stopped ${describe(l)} on ${portsOf(l)}`); } catch { /* already gone */ }
    }
    if (!stop.length && !ownWatchers.length) console.log('no dev server from this clone is listening');
    for (const l of leave) console.log(`left ${describe(l)} on ${portsOf(l)} — not this clone`);
    return;
  }
  console.error('usage: node scripts/dev-ports.js check|stop');
  process.exit(2);
}

if (isMain(import.meta.url)) main(process.argv[2]);
