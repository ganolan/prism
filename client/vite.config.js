import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { devApiProxy } from './devProxy.js';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': devApiProxy(),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test-setup.js',
  },
});
