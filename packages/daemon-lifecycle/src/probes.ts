/**
 * Health-probe building blocks.
 *
 * A daemon's liveness endpoint can answer before every listener it serves is
 * up. waved v0.2.1 is the observed case: /livez returned 200 while its REST
 * gateway was not yet accepting connections, so the first gateway call failed
 * with ECONNREFUSED ("waved gateway unreachable"). "Live" has to mean "every
 * port the app is about to use answers", so probes compose.
 */
import type { HealthProbe } from './types.js';

/** Alive only when every probe is alive (checked in order, stopping at the first that isn't). */
export function allProbes(...probes: readonly HealthProbe[]): HealthProbe {
  return {
    isAlive: async () => {
      for (const probe of probes) {
        if (!(await probe.isAlive())) return false;
      }
      return true;
    },
  };
}

/** Alive when GET `url` returns a 2xx. */
export function httpOkProbe(url: string): HealthProbe {
  return {
    isAlive: async () => {
      try {
        return (await fetch(url)).ok;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Alive when something at `url` answers HTTP at all, whatever the status.
 * A gateway that wants a macaroon answers 401/403/404 to a bare request;
 * that still proves it is listening. Only a connection failure (refused,
 * reset) counts as not alive. `no-cors` lets a webview make the request
 * to another origin: the response is opaque, but it resolves instead of
 * throwing, which is all this needs.
 */
export function httpListeningProbe(url: string): HealthProbe {
  return {
    isAlive: async () => {
      try {
        await fetch(url, { mode: 'no-cors' });
        return true;
      } catch {
        return false;
      }
    },
  };
}
