/**
 * Out-of-process LNC client for the integration suite (issue #44).
 *
 * Each lnc-web WASM client runs in its own child process
 * (lnc-client-child.mjs). The lnc-web Go/wasm runtime can spin without ever
 * yielding to the JavaScript event loop (Go's js/wasm port has no async
 * preemption); hosted inside the vitest worker that froze every timer the
 * suite relied on, so neither per-call timeouts nor the bounded teardown
 * could fire and the job sat silent until the CI limit.
 *
 * Here the parent's event loop never runs wasm, so every bound below is
 * real: calls reject with a descriptive error on deadline, a child that dies
 * fails its pending calls immediately, and dispose() escalates
 * shutdown -> SIGKILL with a deadline on each step.
 */
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_CHILD_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lnc-client-child.mjs');

export interface IsolatedLncClientOptions {
  /** Short name used in errors and log prefixes, e.g. "lnc4". */
  readonly label: string;
  /** Child entrypoint; defaults to lnc-client-child.mjs (tests inject stubs). */
  readonly scriptPath?: string;
  /** Extra environment for the child (merged over process.env). */
  readonly env?: Readonly<Record<string, string>>;
  /** Deadline for the child to load and report ready. */
  readonly startTimeoutMs?: number;
  /** Default deadline for a single call (connect / request). */
  readonly callTimeoutMs?: number;
  /** Time the child gets to disconnect and exit before SIGKILL. */
  readonly shutdownGraceMs?: number;
  /** Time to wait for the exit event after SIGKILL before giving up loudly. */
  readonly killWaitMs?: number;
  /** Child stdout/stderr lines. Defaults to writing `[label] line` to stdout. */
  readonly onLog?: (line: string) => void;
}

export interface LncConnectParams {
  readonly wasmUrl: string;
  readonly namespace: string;
  readonly pairingPhrase: string;
  readonly serverHost: string;
}

type ChildMessage =
  | { readonly type: 'ready' }
  | { readonly type: 'result'; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly type: 'result'; readonly id: number; readonly ok: false; readonly error: string };

type ParentMessage =
  | ({ readonly id: number; readonly op: 'connect' } & LncConnectParams)
  | { readonly id: number; readonly op: 'request'; readonly method: string; readonly request: object }
  | { readonly id: number; readonly op: 'shutdown' };

/** Distributes Omit over a union so each op keeps its own fields. */
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly timer: NodeJS.Timeout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseChildMessage(raw: unknown): ChildMessage | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw['type'] === 'ready') return { type: 'ready' };
  if (raw['type'] !== 'result' || typeof raw['id'] !== 'number') return undefined;
  if (raw['ok'] === true) return { type: 'result', id: raw['id'], ok: true, value: raw['value'] };
  if (raw['ok'] === false) {
    return { type: 'result', id: raw['id'], ok: false, error: String(raw['error']) };
  }
  return undefined;
}

function exitDescription(child: ChildProcess): string {
  return `code=${child.exitCode ?? 'null'} signal=${child.signalCode ?? 'null'}`;
}

function lineForwarder(onLine: (line: string) => void): (chunk: Buffer) => void {
  let carry = '';
  return (chunk) => {
    const parts = (carry + chunk.toString('utf8')).split('\n');
    carry = parts.pop() ?? '';
    for (const line of parts) {
      if (line.trim() !== '') onLine(line);
    }
  };
}

export class IsolatedLncClient {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private exitError: Error | undefined;
  private readonly exited: Promise<void>;
  private disposing: Promise<void> | undefined;

  private constructor(
    readonly label: string,
    readonly child: ChildProcess,
    private readonly opts: Required<Omit<IsolatedLncClientOptions, 'env' | 'scriptPath' | 'onLog' | 'label'>>,
  ) {
    this.exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
    child.on('exit', () => {
      this.exitError = new Error(`LNC client ${label} (pid ${child.pid ?? '?'}) exited (${exitDescription(child)})`);
      this.failAll(this.exitError);
    });
    child.on('message', (raw: unknown) => {
      const msg = parseChildMessage(raw);
      if (msg?.type !== 'result') return;
      const entry = this.pending.get(msg.id);
      if (entry === undefined) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.ok) entry.resolve(msg.value);
      else entry.reject(new Error(`LNC client ${label}: ${msg.error}`));
    });
  }

  /** Fork the child and wait (bounded) until it has loaded lnc-web. */
  static async start(options: IsolatedLncClientOptions): Promise<IsolatedLncClient> {
    const onLog = options.onLog ?? ((line: string) => process.stdout.write(`[${options.label}] ${line}\n`));
    const child = fork(options.scriptPath ?? DEFAULT_CHILD_SCRIPT, [], {
      // Never inherit the vitest worker's loader flags.
      execArgv: [],
      env: { ...process.env, ...options.env },
      serialization: 'advanced',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout?.on('data', lineForwarder(onLog));
    child.stderr?.on('data', lineForwarder(onLog));
    // Spawn failures surface as 'exit'/'error'; keep 'error' from throwing.
    child.on('error', () => {});

    const client = new IsolatedLncClient(options.label, child, {
      startTimeoutMs: options.startTimeoutMs ?? 30_000,
      callTimeoutMs: options.callTimeoutMs ?? 20_000,
      shutdownGraceMs: options.shutdownGraceMs ?? 3_000,
      killWaitMs: options.killWaitMs ?? 5_000,
    });

    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`LNC client ${options.label} did not report ready within ${client.opts.startTimeoutMs}ms`)),
        client.opts.startTimeoutMs,
      );
      child.on('message', (raw: unknown) => {
        if (parseChildMessage(raw)?.type === 'ready') {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error(`LNC client ${options.label} exited before ready (${exitDescription(child)})`));
      });
    });
    try {
      await ready;
    } catch (err) {
      await client.dispose();
      throw err;
    }
    return client;
  }

  get alive(): boolean {
    return this.exitError === undefined && this.child.exitCode === null && this.child.signalCode === null;
  }

  connect(params: LncConnectParams, timeoutMs = 60_000): Promise<void> {
    return this.call({ op: 'connect', ...params }, `connect (mailbox ${params.serverHost})`, timeoutMs).then(() => {});
  }

  /**
   * One RPC over the LNC session. The returned value is whatever lnc-web
   * produced, structured-cloned across the process boundary; callers state
   * the shape they read.
   */
  request<T>(method: string, request: object = {}, timeoutMs = this.opts.callTimeoutMs): Promise<T> {
    return this.call({ op: 'request', method, request }, method, timeoutMs) as Promise<T>;
  }

  /**
   * Ask the child to disconnect and exit; SIGKILL it if it has not exited
   * within the grace period. Every step is bounded, and a child that
   * survives SIGKILL is reported, never waited on forever. Idempotent.
   */
  dispose(): Promise<void> {
    this.disposing ??= this.disposeOnce();
    return this.disposing;
  }

  private async disposeOnce(): Promise<void> {
    if (!this.alive) return this.waitExited(this.opts.killWaitMs);
    // Fire-and-forget: a wedged child never answers, and we never wait on it.
    this.call({ op: 'shutdown' }, 'shutdown', this.opts.shutdownGraceMs).catch(() => {});
    if (await this.waitExited(this.opts.shutdownGraceMs).then(() => true, () => false)) return;
    this.child.kill('SIGKILL');
    await this.waitExited(this.opts.killWaitMs);
  }

  private waitExited(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      this.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`LNC client ${this.label} (pid ${this.child.pid ?? '?'}) did not exit within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]).finally(() => clearTimeout(timer));
  }

  private call(message: WithoutId<ParentMessage>, what: string, timeoutMs: number): Promise<unknown> {
    if (this.exitError !== undefined) return Promise.reject(this.exitError);
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `LNC client ${this.label}: ${what} did not answer within ${timeoutMs}ms ` +
              `(child pid ${this.child.pid ?? '?'} ${this.alive ? 'still running — wasm runtime likely wedged' : 'gone'})`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const outgoing: ParentMessage = { ...message, id };
      try {
        this.child.send(outgoing, (err) => {
          if (err === null) return;
          const entry = this.pending.get(id);
          if (entry === undefined) return;
          this.pending.delete(id);
          clearTimeout(entry.timer);
          entry.reject(new Error(`LNC client ${this.label}: could not send ${what}: ${err.message}`));
        });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`LNC client ${this.label}: could not send ${what}: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  }

  private failAll(err: Error): void {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(err);
    }
  }
}
