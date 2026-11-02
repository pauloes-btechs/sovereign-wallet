import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Web preview build — the real Mode A app over react-native-web, driven by
 * the harness's simulated Wavelength client on regtest. No keys leave the
 * page, no network egress, no real funds. This is the hosted demo target
 * (e.g. Vercel); it is NOT a production web wallet.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'react-native': 'react-native-web',
    },
    extensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.mjs', '.js', '.jsx', '.json'],
  },
  define: {
    __DEV__: JSON.stringify(process.env.NODE_ENV !== 'production'),
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  server: { port: 5174, strictPort: true },
  build: { target: 'es2022', outDir: 'dist' },
});
