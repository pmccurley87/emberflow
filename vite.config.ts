/// <reference types="vitest/config" />
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'studio-dist' },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    watch: {
      // The runner writes workflows/*.json and artifacts/*.json on save/publish;
      // watching them causes a reload loop (save -> file write -> reload -> save).
      ignored: [
        '**/workflows/**',
        '**/artifacts/**',
        '**/emberflow.secrets.json',
        '**/emberflow.environments.json',
      ],
    },
    proxy: {
      // Local Emberflow runner (server/index.ts).
      '/api': {
        target: 'http://127.0.0.1:8092',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
      // Anomaly-detector service (no CORS middleware) — proxied same-origin.
      '/anomaly': {
        target: 'http://localhost:8091',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/anomaly/, ''),
      },
    },
  },
  test: { include: ['src/**/*.test.{ts,tsx}', 'server/**/*.test.ts', 'bin/**/*.test.ts'], passWithNoTests: true },
});
