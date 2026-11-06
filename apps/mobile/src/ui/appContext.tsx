/**
 * App-wide services for screens: the preferences store and the injected
 * device services. Both modes mount one `MobileAppProvider` at the root.
 *
 * Screens rendered without a provider (unit tests of a single screen) get
 * defaults and no device services — never a crash.
 */

import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import {
  createPreferencesStore,
  memoryPreferencesBackend,
} from '../flows/preferences.js';
import type { Preferences, PreferencesSnapshot, PreferencesStore } from '../flows/preferences.js';
import { NO_PLATFORM_SERVICES } from '../flows/platform.js';
import type { PlatformServices } from '../flows/platform.js';
import { amountAccessibilityLabel, formatAmount } from './format.js';

interface MobileAppContextValue {
  readonly preferences: PreferencesStore;
  readonly platform: PlatformServices;
}

const FALLBACK: MobileAppContextValue = {
  preferences: createPreferencesStore(memoryPreferencesBackend()),
  platform: NO_PLATFORM_SERVICES,
};

const MobileAppContext = createContext<MobileAppContextValue>(FALLBACK);

export function MobileAppProvider({
  preferences,
  platform = NO_PLATFORM_SERVICES,
  children,
}: {
  preferences: PreferencesStore;
  platform?: PlatformServices;
  children: ReactNode;
}): ReactNode {
  return (
    <MobileAppContext.Provider value={{ preferences, platform }}>{children}</MobileAppContext.Provider>
  );
}

/**
 * One preferences store per mounted app root: the host's store, or an
 * in-memory one (settings work but do not survive a restart). Loads it if
 * the host has not.
 */
export function usePreferencesStore(given: PreferencesStore | undefined): PreferencesStore {
  const [store] = useState(() => given ?? createPreferencesStore(memoryPreferencesBackend()));
  useEffect(() => {
    if (!store.getSnapshot().loaded) void store.load();
  }, [store]);
  return store;
}

/** The live preferences snapshot plus the store (to `set`). Re-renders on change. */
export function usePreferences(): PreferencesSnapshot & { readonly store: PreferencesStore } {
  const { preferences } = useContext(MobileAppContext);
  const snapshot = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  return { ...snapshot, store: preferences };
}

/** Injected device services (clipboard, share, scanner, keystore…). */
export function usePlatformServices(): PlatformServices {
  return useContext(MobileAppContext).platform;
}

/**
 * Formats amounts with the user's denomination and privacy mode — the hook
 * every amount on every tab goes through.
 */
export function useAmountFormatter(): {
  readonly preferences: Preferences;
  format(sats: bigint, sign?: '+' | '−' | null): string;
  accessibilityLabel(sats: bigint, sign?: '+' | '−' | null): string;
} {
  const { preferences } = usePreferences();
  const options = { denomination: preferences.denomination, hidden: preferences.hideBalances };
  return {
    preferences,
    format: (sats, sign = null) => formatAmount(sats, { ...options, sign }),
    accessibilityLabel: (sats, sign = null) => amountAccessibilityLabel(sats, { ...options, sign }),
  };
}
