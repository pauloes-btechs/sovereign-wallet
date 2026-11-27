/**
 * Node.js child-process runtime — the non-Tauri SidecarRuntime
 * implementation. Used by the package's own tests and the CI waved
 * integration smoke; the desktop app injects its Tauri plugin-shell
 * runtime instead.
 */
import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import type { SidecarExit, SidecarRuntime } from '../types.js';

export interface NodeRuntimeOptions {
  /** Standard IO configuration. Default: all discarded. */
  stdio?: 'ignore' | 'inherit' | 'pipe';
  /**
   * Keep the last N lines the process writes to stderr and report them as
   * `SidecarExit.stderrTail`, so a boot failure names its cause instead of a
   * bare exit code. 0 (default) captures nothing. With `stdio: 'inherit'`
   * the captured stderr is still forwarded to this process's stderr.
   */
  stderrTailLines?: number;
  /** Extra spawn options (env, cwd, …) passed through to `spawn`. */
  options?: { env?: NodeJS.ProcessEnv; cwd?: string };
}

/** How long to wait after 'exit' for buffered stderr to drain before
 *  reporting it. A grandchild holding the pipe open must not hold up exit. */
const STDERR_DRAIN_MS = 250;

export function createNodeChildProcessRuntime(
  program: string,
  { stdio = 'ignore', stderrTailLines = 0, options = {} }: NodeRuntimeOptions = {},
): SidecarRuntime {
  const captureLines = Math.max(0, Math.floor(stderrTailLines));
  const stdioConfig: StdioOptions = captureLines > 0 && stdio !== 'pipe' ? [stdio, stdio, 'pipe'] : stdio;
  return {
    displayName: program,
    spawn(args: string[]) {
      const child: ChildProcess = spawn(program, args, { stdio: stdioConfig, ...options });
      const listeners = new Set<(exit: SidecarExit) => void>();
      let lastExit: SidecarExit | null = null;
      const deliver = (exit: SidecarExit): void => {
        lastExit = exit;
        for (const listener of listeners) listener(exit);
      };

      const tail = captureLines > 0 && child.stderr ? captureStderrTail(child, captureLines, stdio === 'inherit') : undefined;

      child.on('exit', (code, signal) => {
        const base: SidecarExit = { code, signal: signal ?? null };
        if (!tail) {
          deliver(base);
          return;
        }
        void tail.drained().then(() => {
          const text = tail.text();
          deliver(text ? { ...base, stderrTail: text } : base);
        });
      });
      child.on('error', (error: NodeJS.ErrnoException) => {
        if (child.exitCode == null && child.signalCode == null) {
          deliver({ code: null, signal: null, spawnError: error.message });
        }
      });
      return Promise.resolve({
        pid: child.pid ?? -1,
        kill: async () => {
          child.kill();
        },
        onExit(listener) {
          listeners.add(listener);
          // Late-subscriber replay: an exit observed before anyone listened
          // is delivered to the first subscriber instead of being lost.
          if (lastExit) listener(lastExit);
          return () => listeners.delete(listener);
        },
      });
    },
  };
}

interface StderrTail {
  text(): string;
  drained(): Promise<void>;
}

function captureStderrTail(child: ChildProcess, maxLines: number, forward: boolean): StderrTail {
  const stream = child.stderr;
  let lines: string[] = [];
  let partial = '';
  let ended = false;
  const endWaiters: Array<() => void> = [];
  const markEnded = (): void => {
    ended = true;
    for (const resolve of endWaiters.splice(0)) resolve();
  };

  stream?.setEncoding('utf8');
  stream?.on('data', (chunk: string) => {
    if (forward) process.stderr.write(chunk);
    const parts = (partial + chunk).split(/\r?\n/);
    partial = parts.pop() ?? '';
    lines.push(...parts.filter((line) => line.trim() !== ''));
    if (lines.length > maxLines) lines = lines.slice(-maxLines);
  });
  stream?.on('end', markEnded);
  stream?.on('close', markEnded);
  stream?.on('error', markEnded);

  return {
    text() {
      const all = partial.trim() !== '' ? [...lines, partial] : lines;
      return all.slice(-maxLines).join(' | ');
    },
    drained() {
      if (ended || !stream) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, STDERR_DRAIN_MS);
        timer.unref?.();
        endWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}
