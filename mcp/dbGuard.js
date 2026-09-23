/**
 * PrisMCP writes grading suggestions straight into SQLite and loads no dotenv,
 * so an unset DB_PATH resolves beside the code — on a dev clone, a throwaway
 * copy. Every write would then report success into a database nobody meant,
 * and the next `db:refresh` would erase it. Silent, and unrecoverable.
 *
 * So: declare the database or do not start.
 *
 * A *relative* DB_PATH is still accepted — the committed `.mcp.json` uses one,
 * and a clone running beside its own database is the correct default today —
 * but it is resolved to an absolute path and returned, so the caller can report
 * which database was actually opened rather than leaving it to inference.
 */
import { isAbsolute, resolve } from 'node:path';

export function assertExplicitDbPath(env = process.env) {
  const dbPath = String(env.DB_PATH ?? '').trim();
  // `:memory:` and other SQLite URIs are not filesystem paths; pass them through.
  if (dbPath === ':memory:' || dbPath.startsWith('file:')) return dbPath;
  if (dbPath) return isAbsolute(dbPath) ? dbPath : resolve(process.cwd(), dbPath);

  throw new Error(
    'PrisMCP will not start without an explicit DB_PATH.\n' +
      'It writes grading suggestions straight into SQLite, and an unset DB_PATH\n' +
      'resolves to whatever database sits beside the code — on a dev clone that is\n' +
      'a disposable copy, and the writes would be lost at the next db:refresh.\n' +
      'Declare it in your MCP client config, e.g.\n' +
      '  DB_PATH=/Users/you/prism/data/students.db node mcp/server.js',
  );
}
