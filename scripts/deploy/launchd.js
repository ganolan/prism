/**
 * The three launchd agents, rendered as property lists.
 *
 * Agents, not daemons: FileVault is on, so nothing runs until someone unlocks
 * the disk at startup — and that unlock logs them in, which starts the agents.
 * A daemon would start no sooner, and mastery re-login needs the GUI session.
 */
import { join } from 'node:path';
import { LABELS, paths } from './lib.js';

/** Homebrew's stable link. process.execPath resolves to Cellar/node/<version>, which the next upgrade deletes. */
export const NODE_BIN = '/usr/local/bin/node';

/** launchd starts agents with a bare PATH; npm, git, gh, tar and tailscale live in these. */
export const PATH_ENV = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function node(value, pad) {
  const inner = `${pad}  `;
  if (typeof value === 'string') return `${pad}<string>${esc(value)}</string>`;
  if (typeof value === 'number') return `${pad}<integer>${value}</integer>`;
  if (typeof value === 'boolean') return `${pad}<${value}/>`;
  if (Array.isArray(value)) return `${pad}<array>\n${value.map((v) => node(v, inner)).join('\n')}\n${pad}</array>`;
  const entries = Object.entries(value).map(([k, v]) => `${inner}<key>${esc(k)}</key>\n${node(v, inner)}`);
  return `${pad}<dict>\n${entries.join('\n')}\n${pad}</dict>`;
}

export function renderPlist(dict) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    `<plist version="1.0">\n${node(dict, '')}\n</plist>\n`
  );
}

export function agents({ home, node: nodeBin = NODE_BIN }) {
  const p = paths(join(home, 'prism'));
  const log = (name) => join(p.logs, name);
  return {
    server: {
      Label: LABELS.server,
      ProgramArguments: [nodeBin, join(p.current, 'server', 'index.js')],
      WorkingDirectory: p.current,
      EnvironmentVariables: {
        PATH: PATH_ENV,
        HOST: '127.0.0.1',
        PORT: '3001',
        DB_PATH: p.db,
        PRISM_SESSION_DIR: join(p.data, '.playwright-session'),
        INBOX_DIR: join(p.data, 'inbox'),
      },
      RunAtLoad: true,
      KeepAlive: true,
      ThrottleInterval: 10,
      StandardOutPath: log('server.log'),
      StandardErrorPath: log('server.log'),
    },
    deploy: {
      Label: LABELS.deploy,
      ProgramArguments: [nodeBin, join(p.current, 'scripts', 'deploy', 'deploy.js')],
      WorkingDirectory: p.root,
      EnvironmentVariables: { PATH: PATH_ENV, PRISM_ROOT: p.root },
      StartInterval: 30,
      RunAtLoad: true,
      StandardOutPath: log('deploy.log'),
      StandardErrorPath: log('deploy.log'),
    },
    backup: {
      Label: LABELS.backup,
      ProgramArguments: [nodeBin, join(p.current, 'scripts', 'db-backup.js')],
      // PRISM_BACKUP_DIR comes from data/.env, reached through the release's .env link.
      WorkingDirectory: p.current,
      EnvironmentVariables: { PATH: PATH_ENV, DB_PATH: p.db },
      StartCalendarInterval: { Hour: 2, Minute: 0 },
      StandardOutPath: log('backup.log'),
      StandardErrorPath: log('backup.log'),
    },
  };
}

export function installPlan({ home, node: nodeBin = NODE_BIN }) {
  const p = paths(join(home, 'prism'));
  const a = agents({ home, node: nodeBin });
  const agentsDir = join(home, 'Library', 'LaunchAgents');
  return {
    dirs: [p.releases, p.data, p.logs, p.launchd, agentsDir],
    files: [
      { path: join(agentsDir, `${LABELS.server}.plist`), content: renderPlist(a.server) },
      { path: join(agentsDir, `${LABELS.deploy}.plist`), content: renderPlist(a.deploy) },
      // Staged, NOT in LaunchAgents: anything there is loaded at the next login.
      // Before cutover prod's database is empty, and an empty nightly snapshot
      // would become the newest file in _prism-data — the one the laptop's
      // db:restore picks. cutover.js installs and loads it.
      { path: join(p.launchd, `${LABELS.backup}.plist`), content: renderPlist(a.backup) },
    ],
    reload: [LABELS.server, LABELS.deploy],
  };
}
