/**
 * Mode B desktop app — the graphical litd experience.
 *
 * Phase-gated shell over the loopback bridge: the bridge probes the daemon
 * (getInfo + unlock canary) and declares missing / locked / ready / undetermined;
 * the UI renders exactly what is declared, never a guessed state. When ready,
 * tabbed screens expose on-chain, Lightning, channels, and diagnostics.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card } from '@sovereign/ui';

import {
  BridgeClient,
  BridgeHttpError,
  devBridgeBootstrap,
  type BridgeStateView,
} from './bridge-client.js';
import { MissingWalletScreen, UnlockScreen } from './screens/setup-screens.js';
import { DEMO_REPLAY } from '../demo/mode.js';
import { PlatformApp } from '../platform/PlatformApp.js';
import { createReplayClient } from '../demo/replay.js';
import { useDemoFixture } from '../demo/useDemoFixture.js';

const STATE_POLL_MS = 2_000;



/**
 * Resolve the bridge bootstrap for the CURRENT runtime.
 * Packaged Tauri integration (sidecar-managed bridge) is follow-up work and
 * disclosed in the plan; dev/e2e uses validated URL params.
 */
export function useBridgeClient(): { readonly client: BridgeClient | null; readonly reason: string } {
  // The hosted demo never reads bridge params from the URL: it only ever
  // talks to the in-page replay transport.
  const [bootstrap] = useState(() => (DEMO_REPLAY ? null : devBridgeBootstrap(window.location.search)));
  const isTauri = '__TAURI_INTERNALS__' in window;
  const fixture = useDemoFixture();
  return useMemo(() => {
    if (DEMO_REPLAY) {
      return fixture === null
        ? { client: null, reason: 'Loading the recorded regtest session…' }
        : { client: createReplayClient(fixture), reason: '' };
    }
    if (bootstrap) return { client: new BridgeClient(bootstrap), reason: '' };
    if (isTauri) {
      return {
        client: null,
        reason: 'The packaged desktop shell does not manage the litd bridge yet — this screen ships with the Tauri bridge integration.',
      };
    }
    return {
      client: null,
      reason: 'No litd bridge session. In dev or e2e, open this page with ?devBridgeUrl=http://127.0.0.1:PORT&devBridgeToken=TOKEN from a bridge launch.',
    };
  }, [bootstrap, isTauri, fixture]);
}

/** Hoisted poll of the bridge's wallet-phase state. */
export function useBridgeState(client: BridgeClient | null): {
  readonly state: BridgeStateView | null;
  readonly error: string | null;
  readonly refresh: () => void;
} {
  const [state, setState] = useState<BridgeStateView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (client === null) return;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const next = await client.state();
        if (!cancelled) {
          setState(next);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof BridgeHttpError ? err.message : 'bridge unreachable');
        }
      }
    };
    void poll();
    const interval = setInterval(poll, STATE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [client, tick]);

  return { state, error, refresh };
}


/** Setup / unlock / error states: centered, with the node-mode heading. */
/** Setup / unlock / error states: centered, with the node-mode heading. */
function GateFrame({ children }: { readonly children: React.ReactNode }): React.ReactNode {
  return (
    <main style={{ minHeight: '100%', fontFamily: 'system-ui' }}>
      <h1 style={{ textAlign: 'center', paddingTop: 16, margin: 0 }}>Sovereign Wallet — Node mode</h1>
      {children}
    </main>
  );
}

export function ModeBApp(): React.ReactNode {
  const { client, reason } = useBridgeClient();
  const { state, error, refresh } = useBridgeState(client);

  if (client === null) {
    return (
      <GateFrame>
        <Card title="Advanced node mode">
          <p data-testid="modeb-unavailable" style={{ color: '#9aa0a6' }}>{reason}</p>
        </Card>
      </GateFrame>
    );
  }

  if (error !== null && state === null) {
    return (
      <GateFrame>
        <Card title="Advanced node mode">
          <p data-testid="modeb-bridge-error" style={{ color: '#ff6b6b' }}>Bridge unreachable: {error}</p>
          <Button onClick={refresh}>Retry</Button>
        </Card>
      </GateFrame>
    );
  }

  if (state === null) {
    return (
      <GateFrame>
        <Card title="Advanced node mode">
          <p style={{ color: '#9aa0a6' }}>Checking node state…</p>
        </Card>
      </GateFrame>
    );
  }

  // Lifecycle gates first — the wallet screens own these states.
  if (state.phase === 'missing') {
    return (
      <GateFrame>
        <MissingWalletScreen client={client} onDone={refresh} error={state.error} />
      </GateFrame>
    );
  }
  if (state.phase === 'locked') {
    return (
      <GateFrame>
        <UnlockScreen client={client} onDone={refresh} />
      </GateFrame>
    );
  }
  if (state.phase !== 'ready' || state.info === undefined) {
    return (
      <GateFrame>
        <Card title="Advanced node mode">
          <p data-testid="modeb-undetermined" style={{ color: '#f7b955' }}>
            Node state could not be determined.
          </p>
          {state.error !== undefined ? (
            <p style={{ color: '#9aa0a6', fontFamily: 'monospace', fontSize: 12 }}>{state.error}</p>
          ) : null}
          <Button onClick={refresh}>Retry</Button>
        </Card>
      </GateFrame>
    );
  }

  return <PlatformApp client={client} state={state} />;
}
