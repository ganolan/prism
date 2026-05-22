#!/usr/bin/env node
/**
 * Read-only inspection helper.
 *
 * A fixed-capability replacement for ad-hoc `node -e` probes, so the agent can
 * peek at the DB and package metadata without an arbitrary-code allowlist rule.
 * Every operation here is read-only by construction: the SQLite handle is
 * opened `readonly`, and nothing writes to disk. Allowlisting
 * `Bash(node scripts/inspect.js *)` is therefore safe — capabilities are
 * bounded by this file, not by the caller's arguments.
 *
 * Usage:
 *   node scripts/inspect.js db tables
 *   node scripts/inspect.js db count [table]
 *   node scripts/inspect.js db schema <table>
 *   node scripts/inspect.js db sample <table> [n]
 *   node scripts/inspect.js pkg [scripts|deps|all]
 *   node scripts/inspect.js pkg client [scripts|deps|all]
 *   node scripts/inspect.js modversion <module>
 *   node scripts/inspect.js runtime
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.DB_PATH
  ? process.env.DB_PATH
  : join(repoRoot, 'server/db/students.db');

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function print(value) {
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function openDb() {
  try {
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    die(`Cannot open DB (read-only) at ${dbPath}: ${err.message}`);
  }
}

function listTables(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
}

function requireTable(db, table) {
  if (!table) die('Missing <table>. Run `db tables` to list them.');
  const tables = listTables(db);
  if (!tables.includes(table)) {
    die(`Unknown table "${table}". Available: ${tables.join(', ') || '(none)'}`);
  }
  return table;
}

function cmdDb(args) {
  const [sub, table, extra] = args;
  const db = openDb();
  try {
    switch (sub) {
      case 'tables':
        return print(listTables(db));
      case 'count': {
        const targets = table ? [requireTable(db, table)] : listTables(db);
        const counts = {};
        for (const t of targets) {
          counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
        }
        return print(counts);
      }
      case 'schema': {
        const t = requireTable(db, table);
        return print(db.prepare(`PRAGMA table_info("${t}")`).all());
      }
      case 'sample': {
        const t = requireTable(db, table);
        const n = Math.min(Math.max(parseInt(extra ?? '5', 10) || 5, 1), 50);
        return print(db.prepare(`SELECT * FROM "${t}" LIMIT ${n}`).all());
      }
      default:
        return die('db subcommands: tables | count [table] | schema <table> | sample <table> [n]');
    }
  } finally {
    db.close();
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    die(`Cannot read ${path}: ${err.message}`);
  }
}

function cmdPkg(args) {
  let [field, ...rest] = args;
  let pkgPath = join(repoRoot, 'package.json');
  if (field === 'client') {
    pkgPath = join(repoRoot, 'client/package.json');
    field = rest[0];
  }
  const pkg = readJson(pkgPath);
  switch (field) {
    case undefined:
    case 'all':
      return print({
        name: pkg.name,
        version: pkg.version,
        scripts: pkg.scripts,
        dependencies: pkg.dependencies,
        devDependencies: pkg.devDependencies,
      });
    case 'scripts':
      return print(pkg.scripts ?? {});
    case 'deps':
      return print({ dependencies: pkg.dependencies, devDependencies: pkg.devDependencies });
    default:
      return die('pkg fields: scripts | deps | all  (optionally prefixed with `client`)');
  }
}

function cmdModversion(args) {
  const mod = args[0];
  if (!mod) die('Missing <module>.');
  const pkg = readJson(join(repoRoot, 'node_modules', mod, 'package.json'));
  print(`${mod}@${pkg.version}`);
}

function cmdRuntime() {
  print({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    hasFetch: typeof fetch === 'function',
    cwd: process.cwd(),
    repoRoot,
    dbPath,
  });
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'db':
    cmdDb(args);
    break;
  case 'pkg':
    cmdPkg(args);
    break;
  case 'modversion':
    cmdModversion(args);
    break;
  case 'runtime':
    cmdRuntime();
    break;
  default:
    console.log(
      [
        'Read-only inspection helper. Commands:',
        '  db tables                  list tables',
        '  db count [table]           row counts (all tables, or one)',
        '  db schema <table>          column info',
        '  db sample <table> [n]      first n rows (default 5, max 50)',
        '  pkg [scripts|deps|all]     root package.json fields',
        '  pkg client [scripts|deps|all]   client/package.json fields',
        '  modversion <module>        installed version of a node module',
        '  runtime                    node version / platform / fetch availability',
      ].join('\n'),
    );
    if (command) process.exitCode = 1;
}
