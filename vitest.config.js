import { defineConfig } from 'vitest/config';

// Server-side tests only. The client has its own Vitest setup under client/.
export default defineConfig({
  test: {
    include: ['server/**/*.test.js'],
    environment: 'node',
  },
});
