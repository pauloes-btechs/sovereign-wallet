import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Tauri expects a fixed port; CI/dev guard against env drift.
// E2E mode proxies the daemon gateway same-origin: the daemons send no CORS
// headers, so the browser can only reach them through this server.
// - E2E_GATEWAY_URL       → Mode A (waved gateway under /waved)
// - E2E_MODEB_BRIDGE_URL  → Mode B (litd bridge under /modeb)
const modeBProxy = process.env.E2E_MODEB_BRIDGE_URL
  ? {
      '/modeb': {
        target: process.env.E2E_MODEB_BRIDGE_URL,
        changeOrigin: true,
        rewrite: (p: string) => p.replace(/^\/modeb/, ''),
      },
    }
  : undefined;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    proxy:
      process.env.E2E_GATEWAY_URL
        ? {
            '/waved': {
              target: process.env.E2E_GATEWAY_URL,
              changeOrigin: true,
              rewrite: (p) => p.replace(/^\/waved/, ''),
            },
          }
        : modeBProxy,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
});
