import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    // dev 时代理 API + wire 到本地 worker
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
      '/wire': 'http://localhost:8787',
      '/health': 'http://localhost:8787',
    },
  },
});