/**
 * React hook owning the waved sidecar lifecycle: boots on mount, tears down
 * on unmount, exposes the phase machine to the UI. The config object must be
 * referentially stable while the sidecar should stay up — callers memoize.
 */
import { useEffect, useState } from 'react';
import {
  SidecarLifecycleError,
  type SidecarPhase,
} from '@sovereign/daemon-lifecycle';
import { createWavedSidecar, type WavedSidecarConfig } from './waved.js';

export interface WavedSidecarState {
  phase: SidecarPhase;
  /** Set when the sidecar cannot boot — the UI shows a fatal state, never a spinner. */
  error: string | null;
}

export function useWavedSidecar(config: WavedSidecarConfig | null): WavedSidecarState {
  const [phase, setPhase] = useState<SidecarPhase>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!config) return;
    const lifecycle = createWavedSidecar(config);
    const offPhase = lifecycle.onPhase(setPhase);

    let cancelled = false;
    void lifecycle.start().catch((err: unknown) => {
      // A stop() racing the boot is the shutdown path, not a failure.
      if (!cancelled && !(err instanceof SidecarLifecycleError && err.code === 'boot-interrupted-by-stop')) {
        setError(err instanceof SidecarLifecycleError ? (err.detail ?? err.message) : String(err));
      }
    });

    return () => {
      cancelled = true;
      offPhase();
      void lifecycle.stop().catch(() => {
        /* stop-timeout on shutdown is surfaced by the phase machine. */
      });
    };
  }, [config]);

  return { phase, error };
}
