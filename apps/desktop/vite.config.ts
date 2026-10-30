import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Tauri expects a fixed port; CI/dev guard against env drift.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
});
