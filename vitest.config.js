import { defineConfig } from 'vitest/config';

// Server-side + MCP tests. The client has its own Vitest setup under client/.
export default defineConfig({
  test: {
    include: ['server/**/*.test.js', 'mcp/**/*.test.js', 'scripts/**/*.test.js'],
    environment: 'node',
    // Every test file starts on an in-memory database, so no test can open (or delete from) the
    // clone's real server/db/students.db, even through a module it imports (23 Oct 2026). A file
    // that needs another path still sets its own DB_PATH.
    env: { DB_PATH: ':memory:' },
  },
});
