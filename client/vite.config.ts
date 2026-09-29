import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// Tiny React teaching UI — build lands in public/react so the Node gateway can serve it.
export default defineConfig({
  plugins: [react()],
  base: '/react/',
  resolve: {
    alias: {
      '@gateway/clientStream': path.resolve(rootDir, '../src/clientStream.ts'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/chat': 'http://localhost:3000',
      '/chat/stream': 'http://localhost:3000',
      '/query': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
  build: {
    outDir: path.resolve(rootDir, '../public/react'),
    emptyOutDir: true,
  },
});
