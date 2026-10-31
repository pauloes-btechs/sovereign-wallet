/**
 * Mode B desktop app — the graphical litd experience.
 *
 * Phase-gated shell over the loopback bridge: the bridge probes the daemon
 * (getInfo + unlock canary) and declares missing / locked / ready / undetermined;
 * the UI renders exactly what is declared, never a guessed state. When ready,
 * tabbed screens expose on-chain, Lightning, channels, and diagnostics.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card } from '@sovereign/ui';

import {
  BridgeClient,
  BridgeHttpError,
  devBridgeBootstrap,
  type BridgeStateView,
} from './bridge-client.js';
import { MissingWalletScreen, UnlockScreen } from './screens/setup-screens.js';
import { DashboardScreen } from './screens/dashboard-screen.js';
import { ChannelsScreen } from './screens/channels-screen.js';
import { OnchainScreen } from './screens/onchain-screen.js';
import { PayScreen } from './screens/pay-screen.js';
import { DiagnosticsScreen } from './screens/diagnostics-screen.js';
import { BackupsScreen } from './screens/backups-screen.js';
import { RemoteNodeScreen } from './screens/remote-node-screen.js';

const STATE_POLL_MS = 2_000;

export type ModeBTab = 'dashboard' | 'onchain' | 'lightning' | 'channels' | 'diagnostics' | 'backups' | 'remote';

const TAB_LABELS: Record<ModeBTab, string> = {
  dashboard: 'Overview',
  onchain: 'On-chain',
  lightning: 'Lightning',
  channels: 'Channels',
  diagnostics: 'Node health',
  backups: 'Backups',
  remote: 'Remote node',
};

/**
 * Resolve the bridge bootstrap for the CURRENT runtime.
 * Packaged Tauri integration (sidecar-managed bridge) is follow-up work and
 * disclosed in the plan; dev/e2e uses validated URL params.
 */
export function useBridgeClient(): { readonly client: BridgeClient | null; readonly reason: string } {
  const [bootstrap] = useState(() => devBridgeBootstrap(window.location.search));
  const isTauri = '__TAURI_INTERNALS__' in window;
  return useMemo(() => {
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
  }, [bootstrap, isTauri]);
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

function PhaseBadge({ state }: { readonly state: BridgeStateView }): React.ReactNode {
  const label = state.phase === 'ready' ? 'Node ready' : state.phase === 'locked' ? 'Wallet locked' : state.phase === 'missing' ? 'No wallet' : 'State unknown';
  const tone = state.phase === 'ready' ? 'positive' : state.phase === 'undetermined' ? 'warning' : 'neutral';
  return <Badge tone={tone}>{label}</Badge>;
}

export function ModeBApp(): React.ReactNode {
  const { client, reason } = useBridgeClient();
  const { state, error, refresh } = useBridgeState(client);
  const [tab, setTab] = useState<ModeBTab>('dashboard');

  if (client === null) {
    return (
      <Card title="Advanced node mode">
        <p data-testid="modeb-unavailable" style={{ color: '#9aa0a6' }}>{reason}</p>
      </Card>
    );
  }

  if (error !== null && state === null) {
    return (
      <Card title="Advanced node mode">
        <p data-testid="modeb-bridge-error" style={{ color: '#ff6b6b' }}>Bridge unreachable: {error}</p>
        <Button onClick={refresh}>Retry</Button>
      </Card>
    );
  }

  if (state === null) {
    return (
      <Card title="Advanced node mode">
        <p style={{ color: '#9aa0a6' }}>Checking node state…</p>
      </Card>
    );
  }

  // Lifecycle gates first — the wallet screens own these states.
  if (state.phase === 'missing') {
    return (
      <MissingWalletScreen
        client={client}
        onDone={refresh}
        error={state.error}
      />
    );
  }
  if (state.phase === 'locked') {
    return <UnlockScreen client={client} onDone={refresh} />;
  }
  if (state.phase !== 'ready' || state.info === undefined) {
    return (
      <Card title="Advanced node mode">
        <p data-testid="modeb-undetermined" style={{ color: '#f7b955' }}>
          Node state could not be determined.
        </p>
        {state.error !== undefined ? (
          <p style={{ color: '#9aa0a6', fontFamily: 'monospace', fontSize: 12 }}>{state.error}</p>
        ) : null}
        <Button onClick={refresh}>Retry</Button>
      </Card>
    );
  }

  return (
    <div data-testid="modeb-ready">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', padding: '8px 0' }}>
        <PhaseBadge state={state} />
      </div>
      <nav data-testid="modeb-tabs" style={{ display: 'flex', gap: 4, justifyContent: 'center', flexWrap: 'wrap', paddingBottom: 8 }}>
        {(Object.keys(TAB_LABELS) as ModeBTab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              background: tab === t ? '#1f6feb' : 'transparent',
              color: tab === t ? '#ffffff' : '#9aa0a6',
              border: '1px solid #2a2a30',
              borderRadius: 6,
              padding: '6px 12px',
              cursor: 'pointer',
            }}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </nav>
      {tab === 'dashboard' ? <DashboardScreen client={client} info={state.info} /> : null}
      {tab === 'onchain' ? <OnchainScreen client={client} /> : null}
      {tab === 'lightning' ? <PayScreen client={client} /> : null}
      {tab === 'channels' ? <ChannelsScreen client={client} /> : null}
      {tab === 'diagnostics' ? <DiagnosticsScreen client={client} /> : null}
      {tab === 'backups' ? <BackupsScreen client={client} /> : null}
      {tab === 'remote' ? <RemoteNodeScreen /> : null}
    </div>
  );
}
