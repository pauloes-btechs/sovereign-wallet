import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BridgeClient, BridgeStateView } from '../modeb/bridge-client.js';
import { PlatformApi, type ServicesView } from './api.js';

// ——— preferences (per-device; stored locally, never sent anywhere) ———

export interface Prefs {
  readonly unit: 'sats' | 'btc';
  readonly hideAmounts: boolean;
  readonly sidebarCollapsed: boolean;
}

const DEFAULT_PREFS: Prefs = { unit: 'sats', hideAmounts: false, sidebarCollapsed: false };
const PREFS_KEY = 'sovereign.platform.prefs.v1';

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) } : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

interface PrefsCtx extends Prefs {
  set: (patch: Partial<Prefs>) => void;
}

const PrefsContext = createContext<PrefsCtx>({ ...DEFAULT_PREFS, set: () => undefined });

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const set = useCallback((patch: Partial<Prefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        // storage unavailable (private window, preview) — keep in memory
      }
      return next;
    });
  }, []);
  const value = useMemo(() => ({ ...prefs, set }), [prefs, set]);
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export const usePrefs = () => useContext(PrefsContext);

// ——— polling ———

export interface Poll<T> {
  readonly data: T | undefined;
  readonly error: string | null;
  readonly loading: boolean;
  /** Epoch ms of the last successful load. */
  readonly updatedAt: number | null;
  readonly reload: () => Promise<void>;
}

/**
 * Loads `fn` now and every `intervalMs` while the page is visible. Errors are
 * kept next to the last good data (never replaced by invented values).
 */
export function usePoll<T>(fn: () => Promise<T>, intervalMs: number | null, deps: readonly unknown[] = []): Poll<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const alive = useRef(true);

  const reload = useCallback(async () => {
    try {
      const d = await fnRef.current();
      if (!alive.current) return;
      setData(d);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (err) {
      if (!alive.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    setLoading(true);
    void reload();
    if (intervalMs === null) return () => {
      alive.current = false;
    };
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, intervalMs);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [reload, intervalMs, ...deps]);

  return { data, error, loading, updatedAt, reload };
}

// ——— toasts ———

export interface Toast {
  readonly id: number;
  readonly title: string;
  readonly body?: string;
  readonly tone?: 'positive' | 'danger' | 'info';
}

// ——— platform ———

interface PlatformCtx {
  readonly api: PlatformApi;
  readonly bridge: BridgeClient;
  readonly node: BridgeStateView;
  readonly services: Poll<ServicesView>;
  readonly toast: (t: Omit<Toast, 'id'>) => void;
  /** Bumped after any money-moving action so pages refresh immediately. */
  readonly refreshKey: number;
  readonly bumpRefresh: () => void;
}

const PlatformContext = createContext<PlatformCtx | null>(null);

export function PlatformProvider({ bridge, node, children }: { bridge: BridgeClient; node: BridgeStateView; children: ReactNode }) {
  const api = useMemo(() => new PlatformApi(bridge), [bridge]);
  const services = usePoll(() => api.services(), 15_000, [api]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const nextId = useRef(1);
  const toast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = nextId.current++;
    setToasts((ts) => [...ts, { ...t, id }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 6000);
  }, []);
  const bumpRefresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  const value = useMemo(
    () => ({ api, bridge, node, services, toast, refreshKey, bumpRefresh }),
    [api, bridge, node, services, toast, refreshKey, bumpRefresh],
  );
  return (
    <PlatformContext.Provider value={value}>
      {children}
      <div className="p-toasts" aria-live="polite">
        {toasts.map((t) => (
          <div className="p-toast" key={t.id} data-tone={t.tone}>
            <div style={{ fontWeight: 500 }}>{t.title}</div>
            {t.body ? <div className="p-muted" style={{ fontSize: 13 }}>{t.body}</div> : null}
          </div>
        ))}
      </div>
    </PlatformContext.Provider>
  );
}

export function usePlatform(): PlatformCtx {
  const ctx = useContext(PlatformContext);
  if (ctx === null) throw new Error('usePlatform outside PlatformProvider');
  return ctx;
}

/** Is a litd sub-server running right now? (null while unknown) */
export function useService(name: 'loop' | 'pool' | 'taproot-assets' | 'faraday' | 'lnd'): { running: boolean | null; error: string | null } {
  const { services } = usePlatform();
  const s = services.data?.subServers?.[name];
  if (s === undefined) return { running: services.data ? false : null, error: services.data?.statusError ?? null };
  return { running: s.running, error: s.error || null };
}
