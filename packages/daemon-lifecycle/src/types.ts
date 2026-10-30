/**
 * Sidecar lifecycle ports — the seams that make process management testable.
 *
 * Spec basis (Mode A design, locked): desktop daemons run as sidecar
 * processes; one process model across both modes. This package holds the
 * generic engine; each adapter (wavelength now, litd later) supplies its own
 * runtime (Tauri plugin-shell today) and health probe (waved /livez today).
 *
 * Everything here is pure TypeScript — no node or Tauri imports. Platform
 * runtimes implement these ports; tests supply fakes or real subprocesses.
 */

/** Terminal observation of a sidecar process. */
export interface SidecarExit {
  /** Exit code; `null` when terminated by a signal or never fully spawned. */
  readonly code: number | null;
  /** Signal name/number if terminated by signal; `null` otherwise. */
  readonly signal?: number | string | null;
  /** Set when the process could not be spawned at all (binary missing, permission denied). */
  readonly spawnError?: string;
}

/** Handle to one running sidecar process instance. */
export interface SidecarProcessHandle {
  readonly pid: number;
  /** Request process termination. Must not throw if the process already exited. */
  kill(): Promise<void>;
  /**
   * Subscribe to process termination. Register BEFORE any await so an
   * immediate exit is never missed. Returns an unsubscribe function.
   */
  onExit(listener: (exit: SidecarExit) => void): () => void;
}

/** Spawns sidecar processes. Implemented per platform (Tauri plugin-shell; fakes in tests). */
export interface SidecarRuntime {
  /** Human-readable identity for error messages, e.g. "waved sidecar". */
  readonly displayName: string;
  spawn(args: string[]): Promise<SidecarProcessHandle>;
}

/**
 * Liveness check. MUST resolve (never reject); resolve `false` on any probe
 * failure — an unreachable daemon is "not alive", not an exception.
 */
export interface HealthProbe {
  isAlive(): Promise<boolean>;
}

/**
 * Lifecycle phases:
 *
 *   idle → starting → live → stopping → stopped
 *                     live → restarting → live      (crash, below restart cap)
 *   starting/live/restarting → failed               (boot failure, timeout, restart cap)
 */
export type SidecarPhase =
  | 'idle'
  | 'starting'
  | 'live'
  | 'restarting'
  | 'stopping'
  | 'stopped'
  | 'failed';

/** Typed failures — callers branch on `code`, never on message text. */
export type SidecarLifecycleErrorCode =
  | 'already-started'
  | 'boot-timeout'
  | 'boot-exit'
  | 'boot-interrupted-by-stop'
  | 'restart-cap-reached'
  | 'stop-timeout';

export class SidecarLifecycleError extends Error {
  readonly code: SidecarLifecycleErrorCode;
  readonly detail?: string;

  constructor(code: SidecarLifecycleErrorCode, detail?: string) {
    super(`sidecar lifecycle: ${code}${detail ? ` (${detail})` : ''}`);
    this.name = 'SidecarLifecycleError';
    this.code = code;
    this.detail = detail;
  }
}

export interface SidecarLifecycleOptions {
  runtime: SidecarRuntime;
  health: HealthProbe;
  /**
   * Rebuilds the argument list for every (re)start. A function, not a value:
   * restarts must never reuse a mutated array.
   */
  args: () => string[];
  /** Max time from spawn to first healthy probe. Default 60_000. */
  bootTimeoutMs?: number;
  /** Interval between health probes while booting. Default 500. */
  healthPollIntervalMs?: number;
  /** Grace between kill() and expected exit before stop() gives up. Default 5_000. */
  killGraceMs?: number;
  /** Crash-restart attempts allowed before the lifecycle gives up. Default 3. */
  maxRestarts?: number;
  /** Delay before restart attempt n (1-based). Default exponential, capped at 15s. */
  restartBackoffMs?: (attempt: number) => number;
}
