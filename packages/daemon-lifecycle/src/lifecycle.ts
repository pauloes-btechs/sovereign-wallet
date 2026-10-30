/**
 * Sidecar lifecycle engine — spawn, wait for health, stop, crash-restart.
 *
 * Design rules:
 * - One generation counter per process instance. Every timer/poll/exit
 *   closure captures its generation and aborts when stale — a stop() always
 *   wins over an in-flight boot or backoff timer, with no phase races.
 * - Exit BEFORE the first healthy probe of a first start is a boot failure
 *   (deterministic — bad args, missing binary, broken env) → terminal
 *   `failed`, and start() rejects. Exit AFTER a healthy period is a crash →
 *   automatic restart with backoff, up to `maxRestarts` consecutive
 *   failures. Restarting a config error would hide it; hiding a runtime
 *   crash would strand the user. That asymmetry is the point.
 * - Restart cap: `maxRestarts` caps TOTAL automatic crash-restarts per
 *   instance and never resets on a healthy run — a crash-looping daemon
 *   (live briefly, crash, repeat) must surface as `failed`, not spin
 *   forever. A manual start() from 'failed' is allowed; if it crashes
 *   again the already-spent cap refuses further automatic restarts.
 */

import type {
  HealthProbe,
  SidecarExit,
  SidecarLifecycleOptions,
  SidecarPhase,
  SidecarProcessHandle,
  SidecarRuntime,
} from './types.js';
import { SidecarLifecycleError } from './types.js';

export interface SidecarSnapshot {
  readonly phase: SidecarPhase;
  /** Total crash-restarts performed since construction (display). */
  readonly restarts: number;
  readonly lastExit?: SidecarExit;
}

export class SidecarLifecycle {
  private readonly runtime: SidecarRuntime;
  private readonly health: HealthProbe;
  private readonly args: () => string[];
  private readonly bootTimeoutMs: number;
  private readonly healthPollIntervalMs: number;
  private readonly killGraceMs: number;
  private readonly maxRestarts: number;
  private readonly backoffMs: (attempt: number) => number;

  private phaseValue: SidecarPhase = 'idle';
  private restartsValue = 0;
  private lastExitValue?: SidecarExit;
  private active?: { generation: number; handle: SidecarProcessHandle };
  private generation = 0;
  private readonly phaseListeners = new Set<(phase: SidecarPhase) => void>();

  constructor(options: SidecarLifecycleOptions) {
    this.runtime = options.runtime;
    this.health = options.health;
    this.args = options.args;
    this.bootTimeoutMs = options.bootTimeoutMs ?? 60_000;
    this.healthPollIntervalMs = options.healthPollIntervalMs ?? 500;
    this.killGraceMs = options.killGraceMs ?? 5_000;
    this.maxRestarts = options.maxRestarts ?? 3;
    this.backoffMs = options.restartBackoffMs ?? defaultBackoff;
  }

  get phase(): SidecarPhase {
    return this.phaseValue;
  }

  get restarts(): number {
    return this.restartsValue;
  }

  get lastExit(): SidecarExit | undefined {
    return this.lastExitValue;
  }

  onPhase(listener: (phase: SidecarPhase) => void): () => void {
    this.phaseListeners.add(listener);
    return () => this.phaseListeners.delete(listener);
  }

  snapshot(): SidecarSnapshot {
    return {
      phase: this.phaseValue,
      restarts: this.restartsValue,
      lastExit: this.lastExitValue,
    };
  }

  /** Spawns the sidecar and resolves once it first reports healthy. */
  async start(): Promise<void> {
    if (
      this.phaseValue === 'starting' ||
      this.phaseValue === 'live' ||
      this.phaseValue === 'restarting' ||
      this.phaseValue === 'stopping'
    ) {
      throw new SidecarLifecycleError('already-started', `phase=${this.phaseValue}`);
    }
    const interrupted = await this.boot('starting');
    if (interrupted) {
      throw new SidecarLifecycleError('boot-interrupted-by-stop');
    }
  }

  /**
   * Stops the sidecar and resolves once the process has exited. Idempotent;
   * cancels any in-flight boot or pending restart. Rejects with
   * `stop-timeout` only if the process ignores termination past the grace.
   */
  async stop(): Promise<void> {
    // Bump the generation FIRST: any in-flight boot/backoff/poll now sees a
    // stale generation and aborts without touching the phase.
    const generation = ++this.generation;
    const run = this.active;
    this.active = undefined;

    if (this.phaseValue === 'idle' || this.phaseValue === 'stopped' || this.phaseValue === 'failed' || !run) {
      this.setPhase('stopped');
      return;
    }

    this.setPhase('stopping');
    const exited = new Promise<void>((resolve) => {
      const unsubscribe = run.handle.onExit(() => {
        unsubscribe();
        resolve();
      });
    });

    try {
      await run.handle.kill();
    } catch (error) {
      // Already-dead processes surface as kill errors on some platforms;
      // the exit listener decides whether we are actually done.
      void error;
    }

    const outcome = await orTimeout(exited, this.killGraceMs);
    if (!outcome.settled) {
      throw new SidecarLifecycleError(
        'stop-timeout',
        `${this.runtime.displayName} pid=${run.handle.pid} ignored termination for ${this.killGraceMs}ms`,
      );
    }
    if (generation === this.generation) {
      this.setPhase('stopped');
    }
  }

  /** Boot path shared by first start and crash restarts. Returns `true` when
   *  stop() invalidated this boot; the caller owns the interruption. */
  private async boot(entryPhase: 'starting' | 'restarting'): Promise<boolean> {
    const generation = ++this.generation;
    this.setPhase(entryPhase);

    let handle: SidecarProcessHandle;
    try {
      handle = await this.runtime.spawn(this.args());
    } catch (error) {
      this.lastExitValue = { code: null, spawnError: describeError(error) };
      if (generation !== this.generation) return true; // stop() raced the spawn.
      this.setPhase('failed');
      if (entryPhase === 'starting') {
        throw new SidecarLifecycleError('boot-exit', describeError(error));
      }
      return false;
    }

    this.active = { generation, handle };

    let resolveExit: ((exit: SidecarExit) => void) | undefined;
    const exitPromise = new Promise<SidecarExit>((resolve) => {
      resolveExit = resolve;
    });
    handle.onExit((exit) => resolveExit?.(exit));

    const healthy = this.pollUntilHealthy(generation);
    let clearBootTimeout = (): void => {};
    const timeoutPromise = new Promise<ExitOutcome>((resolve) => {
      const timer = setTimeout(() => resolve({ kind: 'timeout' }), this.bootTimeoutMs);
      unrefTimer(timer);
      clearBootTimeout = () => clearTimeout(timer);
    });

    const outcome = await Promise.race([
      exitPromise.then((exit): ExitOutcome => ({ kind: 'exit', exit })),
      healthy.then((): ExitOutcome => ({ kind: 'healthy' })),
      timeoutPromise,
    ]);
    clearBootTimeout();
    if (generation !== this.generation) return true; // stop() owns the phase now.

    if (outcome.kind === 'exit') {
      this.lastExitValue = outcome.exit;
      this.active = undefined;
      await this.afterUnhealthyBoot(entryPhase, generation, outcome.exit, 'boot-exit');
      return false;
    }
    if (outcome.kind === 'timeout') {
      this.active = undefined;
      await this.terminateStale(handle);
      this.lastExitValue = this.lastExitValue ?? { code: null };
      await this.afterUnhealthyBoot(
        entryPhase,
        generation,
        { code: null },
        'boot-timeout',
        `no healthy probe within ${this.bootTimeoutMs}ms`,
      );
      return false;
    }

    // Healthy: watch for crashes while live.
    this.setPhase('live');
    this.watchForCrash(generation, handle);
    return false;
  }

  /** A boot ended without a healthy probe: count it, then fail or schedule the next restart. */
  private afterUnhealthyBoot(
    entryPhase: 'starting' | 'restarting',
    generation: number,
    exit: SidecarExit,
    code: 'boot-exit' | 'boot-timeout',
    detailOverride?: string,
  ): void {
    if (generation !== this.generation) return;
    const detail = detailOverride ?? describeExit(exit);

    if (entryPhase === 'restarting') {
      // A restart attempt consumed one unit of the restart budget.
      this.restartsValue += 1;
    }
    if (this.restartsValue > this.maxRestarts) {
      this.setPhase('failed');
      if (entryPhase === 'starting') {
        throw new SidecarLifecycleError('restart-cap-reached', detail);
      }
      return;
    }
    if (entryPhase === 'starting') {
      // Deterministic boot failures are not retried — surface immediately.
      this.setPhase('failed');
      throw new SidecarLifecycleError(code, detail);
    }

    this.setPhase('restarting');
    this.scheduleRestart(generation);
  }

  /** A LIVE process exited: count the crash, then fail or schedule a restart. */
  private watchForCrash(generation: number, handle: SidecarProcessHandle): void {
    handle.onExit((exit) => {
      if (generation !== this.generation || this.phaseValue === 'stopping' || this.phaseValue === 'stopped') {
        return; // stop() owns this transition.
      }
      this.lastExitValue = exit;
      this.active = undefined;
      this.restartsValue += 1;
      if (this.restartsValue > this.maxRestarts) {
        this.setPhase('failed');
        return;
      }
      this.setPhase('restarting');
      this.scheduleRestart(generation);
    });
  }

  private scheduleRestart(generation: number): void {
    const delay = this.backoffMs(this.restartsValue);
    const timer = setTimeout(() => {
      if (generation !== this.generation || this.phaseValue !== 'restarting') return;
      void this.boot('restarting').catch(() => {
        /* Terminal paths already landed the phase on 'failed'. */
      });
    }, delay);
    unrefTimer(timer);
  }

  private async terminateStale(handle: SidecarProcessHandle): Promise<void> {
    try {
      await handle.kill();
      const exited = new Promise<void>((resolve) => {
        const unsubscribe = handle.onExit(() => {
          unsubscribe();
          resolve();
        });
      });
      await orTimeout(exited, this.killGraceMs);
    } catch {
      // Best-effort cleanup on the timeout path; the boot failure is the
      // real signal and is surfaced by the caller.
    }
  }

  private async pollUntilHealthy(generation: number): Promise<boolean> {
    for (;;) {
      if (generation !== this.generation) return false;
      const alive = await this.health.isAlive();
      if (generation !== this.generation) return false;
      if (alive) return true;
      await sleep(this.healthPollIntervalMs);
    }
  }

  private setPhase(phase: SidecarPhase): void {
    if (this.phaseValue === phase) return;
    this.phaseValue = phase;
    for (const listener of this.phaseListeners) listener(phase);
  }
}

type ExitOutcome = { kind: 'exit'; exit: SidecarExit } | { kind: 'healthy' } | { kind: 'timeout' };

function defaultBackoff(attempt: number): number {
  return Math.min(1_000 * 2 ** (attempt - 1), 15_000);
}

function describeExit(exit: SidecarExit): string {
  if (exit.spawnError) return `spawn failed: ${exit.spawnError}`;
  if (exit.signal != null) return `terminated by signal ${exit.signal}`;
  return `process exited with code ${exit.code}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves `{ settled: true }` once the promise settles within `ms`,
 *  `{ settled: false }` otherwise. Never rejects. */
function orTimeout<T>(promise: Promise<T>, ms: number): Promise<{ settled: boolean; value?: T }> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve({ settled: false });
      }
    }, ms);
    unrefTimer(timer);
    promise.then(
      (value) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve({ settled: true, value });
        }
      },
      () => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve({ settled: true });
        }
      },
    );
  });
}

/**
 * Node timers keep the event loop (and test workers) alive; browser timers
 * are plain numbers. Unref wherever the runtime allows.
 */
function unrefTimer(timer: unknown): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    (timer as { unref: () => void }).unref();
  }
}
