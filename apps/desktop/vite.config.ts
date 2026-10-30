import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Tauri expects a fixed port; CI/dev guard against env drift.
// E2E mode proxies the waved gateway same-origin: the daemon sends no CORS
// headers, so the browser can only reach it through this server.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    proxy: process.env.E2E_GATEWAY_URL
      ? {
          '/waved': {
            target: process.env.E2E_GATEWAY_URL,
            changeOrigin: true,
            rewrite: (p) => p.replace(/^\/waved/, ''),
          },
        }
      : undefined,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
});
