#!/usr/bin/env node
/**
 * One-time bring-up of prod on this Mac; safe to re-run. Run from a dev clone:
 *
 *   npm run prism:install -- --env-from ~/repos/prism/.env
 *
 * Creates ~/prism, clones the repo, copies the secrets to ~/prism/data/.env
 * (never overwriting), writes the launchd agents, deploys the current CI-green
 * main as the first release, and starts the server and the deploy poller.
 *
 * It does NOT restore a database, load the backup agent, or publish on the
 * tailnet — those are cutover (scripts/deploy/cutover.js).
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isMain } from '../../server/lib/isMain.js';
import { deploy } from './deploy.js';
import { REPO_SLUG, deployEffects, start, unload } from './effects.js';
import { installPlan } from './launchd.js';
import { currentRelease, LABELS, paths } from './lib.js';

async function main() {
  const home = homedir();
  const root = join(home, 'prism');
  const p = paths(root);
  const i = process.argv.indexOf('--env-from');
  const envFrom = i > -1 ? process.argv[i + 1] : undefined;
  const log = (m) => console.log(m);

  const plan = installPlan({ home });
  for (const dir of plan.dirs) mkdirSync(dir, { recursive: true });

  if (!existsSync(p.repo)) {
    log(`cloning ${REPO_SLUG} into ${p.repo}`);
    execFileSync('git', ['clone', '--quiet', `https://github.com/${REPO_SLUG}.git`, p.repo], { stdio: 'inherit' });
  }

  if (!existsSync(p.env)) {
    if (!envFrom) throw new Error(`${p.env} does not exist. Re-run with --env-from <path to a .env with the Schoology keys>.`);
    copyFileSync(envFrom, p.env);
    chmodSync(p.env, 0o600);
    log(`secrets copied to ${p.env} (mode 600)`);
  }

  for (const f of plan.files) {
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, f.content);
  }
  log('launchd agents written');

  if (!currentRelease(root)) {
    log('first deploy (origin/main must be CI-green)');
    const r = await deploy({ root, fx: deployEffects(root), log });
    if (r.action !== 'deployed') throw new Error(`The first deploy did not complete: ${JSON.stringify(r)}`);
  } else {
    unload(LABELS.server);
    start(LABELS.server);
  }

  // Started explicitly: while the GUI domain is on-demand-only, launchd holds
  // back RunAtLoad and would leave the watcher loaded but never running.
  unload(LABELS.deploy);
  start(LABELS.deploy);

  log(
    `\nprod is up on http://127.0.0.1:3001 (loopback only) serving ${currentRelease(root)}` +
      '\nThe database is EMPTY until cutover. Nothing is published on the tailnet and the nightly backup is not loaded.' +
      '\nLogs: ~/prism/logs/{server,deploy}.log',
  );
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
