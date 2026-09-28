import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Proxy /api to the FastAPI backend so the browser sees a same-origin API
// during development (no CORS surprises); backend must be on :8000.
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    // Single-file build: one self-contained HTML (JS+CSS inlined). Used by the
    // thread preview / static demo; `npm run build:server` makes the normal
    // multi-file bundle that FastAPI serves.
    ...(mode === 'singlefile' ? [viteSingleFile()] : []),
  ],
  // Relative base so the built app works from any static origin
  // (FastAPI mount at /, or the preview/static server).
  base: './',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
}));
