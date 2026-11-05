/**
 * Build-time demo switch. `VITE_SOVEREIGN_DEMO=replay` is set only by the
 * hosted demo build (vercel.json "desktop" service). Vite inlines it, so in
 * the Tauri app and every other build this is the constant `false` and the
 * replay code + fixtures are dropped from the bundle.
 */
export const DEMO_REPLAY: boolean = import.meta.env.VITE_SOVEREIGN_DEMO === 'replay';
