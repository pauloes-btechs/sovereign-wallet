/**
 * Generic sidecar lifecycle — spawn, health-gated start, clean stop,
 * crash-restart with backoff. Platform runtimes (Tauri plugin-shell today)
 * and health probes (waved /livez today) are injected; litd reuses the same
 * engine with its own probe later (spec: one process model across modes).
 */
export { SidecarLifecycle } from './lifecycle.js';
export type { SidecarSnapshot } from './lifecycle.js';
export { SidecarLifecycleError } from './types.js';
export type {
  HealthProbe,
  SidecarExit,
  SidecarLifecycleErrorCode,
  SidecarLifecycleOptions,
  SidecarPhase,
  SidecarProcessHandle,
  SidecarRuntime,
} from './types.js';
