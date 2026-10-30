/**
 * Tauri plugin-shell sidecar runtime — the desktop implementation of the
 * SidecarRuntime port (packages/daemon-lifecycle). Spawn/kill/exit semantics
 * follow the verified plugin-shell v2 API: register `close`/`error` listeners
 * BEFORE `spawn()` so no exit is ever missed, and replay the latest exit to
 * late subscribers (late-subscriber race hardening, same as the node runtime).
 */
import { Command } from '@tauri-apps/plugin-shell';
import type { SidecarExit, SidecarRuntime } from '@sovereign/daemon-lifecycle';

export function createTauriSidecarRuntime(displayName: string): SidecarRuntime {
  return {
    displayName,
    async spawn(args: string[]) {
      const command = Command.sidecar('binaries/waved', args);

      const listeners = new Set<(exit: SidecarExit) => void>();
      let lastExit: SidecarExit | null = null;
      const deliver = (exit: SidecarExit): void => {
        if (lastExit !== null) return; // first terminal observation wins
        lastExit = exit;
        for (const listener of listeners) listener(exit);
      };
      command.on('close', (payload: { code: number | null }) => {
        deliver({ code: payload.code, signal: null });
      });
      command.on('error', (message: unknown) => {
        deliver({ code: null, signal: null, spawnError: String(message) });
      });

      const child = await command.spawn();
      return {
        pid: child.pid,
        kill: () => child.kill(),
        onExit(listener) {
          listeners.add(listener);
          if (lastExit) listener(lastExit);
          return () => listeners.delete(listener);
        },
      };
    },
  };
}
