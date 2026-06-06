import { pathToFileURL } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getDb } from '../server/db/index.js';
import { listCourses } from './handlers.js';

// <2KB tool-search hint (spec §3.4) so a client knows when to surface PrisMCP.
export const INSTRUCTIONS =
  "Read a Prism-tracked course/assignment's roster, rubric measurement-topics, " +
  'and current grades, and write AI grading suggestions back into Prism for ' +
  'teacher review. Use when grading student work for a course managed in Prism.';

// Open the shared Prism DB (resolved relative to server/db, honoring DB_PATH)
// and set busy_timeout so a brief write collision with the Express server
// retries rather than throwing SQLITE_BUSY under WAL (spec §7). Returns the
// shared getDb() singleton — the same connection the tool handlers query.
export function connectDb() {
  const db = getDb();
  db.pragma('busy_timeout = 5000');
  return db;
}

// Build the PrisMCP server with all tools/resources/prompts registered. Pure
// construction — no transport, no DB side effects — so tests can drive it over
// an in-memory transport against a seeded :memory: DB.
export function createServer() {
  const server = new McpServer(
    { name: 'prism', version: '0.1.0' },
    { instructions: INSTRUCTIONS }
  );

  server.registerTool(
    'list_courses',
    { description: 'List active (non-archived) Prism courses, to resolve which class to grade.' },
    async () => ({ content: [{ type: 'text', text: JSON.stringify(listCourses(getDb())) }] })
  );

  return server;
}

// Entrypoint: open the shared DB (resolved relative to server/db, honoring
// DB_PATH) and serve over stdio. Guarded so importing this module in tests
// does not boot a server.
async function main() {
  connectDb();
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[prismcp] fatal:', err);
    process.exit(1);
  });
}
