/**
 * Node.js child-process runtime — the non-Tauri SidecarRuntime
 * implementation. Used by the package's own tests and the CI waved
 * integration smoke; the desktop app injects its Tauri plugin-shell
 * runtime instead.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { SidecarExit, SidecarRuntime } from '../types.js';

export interface NodeRuntimeOptions {
  /** Standard IO configuration. Default: all discarded. */
  stdio?: 'ignore' | 'inherit' | 'pipe';
  /** Extra spawn options (env, cwd, …) passed through to `spawn`. */
  options?: { env?: NodeJS.ProcessEnv; cwd?: string };
}

export function createNodeChildProcessRuntime(
  program: string,
  { stdio = 'ignore', options = {} }: NodeRuntimeOptions = {},
): SidecarRuntime {
  return {
    displayName: program,
    spawn(args: string[]) {
      const child: ChildProcess = spawn(program, args, { stdio, ...options });
      const listeners = new Set<(exit: SidecarExit) => void>();
      let lastExit: SidecarExit | null = null;
      const deliver = (exit: SidecarExit): void => {
        lastExit = exit;
        for (const listener of listeners) listener(exit);
      };
      child.on('exit', (code, signal) => deliver({ code, signal: signal ?? null }));
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
