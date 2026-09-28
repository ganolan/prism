#!/usr/bin/env node
// Dev-server port guard. Prod runs on the Mac mini at 127.0.0.1:3001 (launchd
// com.prism.server, cwd ~/prism/releases/<release>), and dev clones share that
// machine. A blanket `lsof -ti:3001 | xargs kill` therefore kills PROD, and a
// dev API that loses the port race leaves the dev UI proxying to prod.
//
//   node scripts/dev-ports.js check   (runs as `predev`) — refuse to start when
//        the API port is taken, naming who holds it and what to do instead.
//   node scripts/dev-ports.js stop    (`npm run dev:stop`) — kill only listeners
//        whose working directory is inside THIS clone; report and leave others.
import { execFileSync } from 'child_process';
import { resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { isMain } from '../server/lib/isMain.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const VITE_PORT = 5173;

/** Split listeners into those running from inside `repoRoot` and everyone else. */
export function classifyListeners(listeners, repoRoot) {
  const inside = (cwd) => !!cwd && (cwd === repoRoot || cwd.startsWith(repoRoot + sep));
  return {
    owned: listeners.filter((l) => inside(l.cwd)),
    foreign: listeners.filter((l) => !inside(l.cwd)),
  };
}

const describe = (l) => `pid ${l.pid} (${l.command}, cwd ${l.cwd ?? 'unknown'})`;

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
    for (const port of [apiPort, VITE_PORT]) {
      const { owned, foreign } = classifyListeners(listenersOn(port), REPO_ROOT);
      for (const l of owned) {
        try { process.kill(l.pid, 'SIGTERM'); console.log(`stopped ${describe(l)} on :${port}`); } catch { /* already gone */ }
      }
      for (const l of foreign) console.log(`left ${describe(l)} on :${port} — not this clone`);
    }
    return;
  }
  console.error('usage: node scripts/dev-ports.js check|stop');
  process.exit(2);
}

if (isMain(import.meta.url)) main(process.argv[2]);
