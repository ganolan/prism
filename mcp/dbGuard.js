/**
 * PrisMCP writes grading suggestions straight into SQLite and loads no dotenv.
 * Whatever DB_PATH it is given is the database every write lands in, and each
 * write reports success — so a wrong one is silent, and on a disposable clone
 * the work is erased at the next db:refresh.
 *
 * Hence DB_PATH must be declared, and it must be ABSOLUTE. A relative path
 * means "whichever directory the client launched me from" — the inference this
 * guard exists to remove. And Claude Code's project scope (.mcp.json) outranks
 * user scope, so a relative entry committed to the repo would silently beat a
 * correctly configured route to the server's database.
 */
import { isAbsolute } from 'node:path';

const HOW =
  'Configure it once per machine, user-scoped, e.g.\n' +
  '  claude mcp add prism -s user -e DB_PATH=/Users/you/prism/data/students.db -- /usr/local/bin/node /Users/you/prism/current/mcp/server.js\n' +
  'See docs/prismcp-install-and-verify.md.';

export function assertExplicitDbPath(env = process.env) {
  const dbPath = String(env.DB_PATH ?? '').trim();
  // SQLite's in-memory database and URI filenames are not filesystem paths.
  if (dbPath === ':memory:' || dbPath.startsWith('file:')) return dbPath;
  if (!dbPath) {
    throw new Error(`PrisMCP will not start without an explicit DB_PATH.\n${HOW}`);
  }
  if (!isAbsolute(dbPath)) {
    throw new Error(
      `PrisMCP needs an ABSOLUTE DB_PATH, got "${dbPath}".\n` +
        'A relative path resolves against whichever directory the client launched it from,\n' +
        'so the database it writes to would depend on where Claude happened to start.\n' +
        HOW,
    );
  }
  return dbPath;
}
