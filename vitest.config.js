import { defineConfig } from 'vitest/config';

// Server-side + MCP tests. The client has its own Vitest setup under client/.
export default defineConfig({
  test: {
    include: ['server/**/*.test.js', 'mcp/**/*.test.js'],
    environment: 'node',
  },
});
