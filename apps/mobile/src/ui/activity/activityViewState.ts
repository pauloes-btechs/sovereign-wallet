/**
 * The Activity tab's filter and search, kept per wallet controller so they
 * survive tab switches and a trip into a receipt, and so Home can open
 * Activity already filtered ("View pending"). Keyed by the controller
 * object (a WeakMap), so each mounted wallet has its own and nothing
 * outlives it.
 */

import { useSyncExternalStore } from 'react';
import { DEFAULT_ACTIVITY_FILTER } from '../../flows/activity.js';
import type { ActivityFilter } from '../../flows/activity.js';

export interface ActivityViewStore {
  get(): ActivityFilter;
  set(patch: Partial<ActivityFilter>): void;
  reset(): void;
  subscribe(listener: () => void): () => void;
}

function createActivityViewStore(): ActivityViewStore {
  let filter: ActivityFilter = DEFAULT_ACTIVITY_FILTER;
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of listeners) listener();
  };
  return {
    get: () => filter,
    set: (patch) => {
      filter = { ...filter, ...patch };
      emit();
    },
    reset: () => {
      filter = DEFAULT_ACTIVITY_FILTER;
      emit();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const stores = new WeakMap<object, ActivityViewStore>();

/** The filter store for one wallet controller. */
export function activityViewStore(owner: object): ActivityViewStore {
  let store = stores.get(owner);
  if (store === undefined) {
    store = createActivityViewStore();
    stores.set(owner, store);
  }
  return store;
}

/** The live filter for one wallet controller, plus its store. */
export function useActivityFilter(owner: object): { filter: ActivityFilter; store: ActivityViewStore } {
  const store = activityViewStore(owner);
  const filter = useSyncExternalStore(store.subscribe, store.get);
  return { filter, store };
}
