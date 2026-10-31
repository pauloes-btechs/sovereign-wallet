/**
 * Mode B remote-node connection guidance.
 *
 * Remote-LND credentials are supplied to the bridge CLI (TLS cert, macaroon,
 * host) — never typed into the webview, which has no secure keystore in the
 * packaged shell yet. This screen explains what to run and verifies nothing
 * it cannot prove: it renders instructions, not a fake "connected" state.
 */
import { Card } from '@sovereign/ui';

export function RemoteNodeScreen(): React.ReactNode {
  return (
    <Card title="Connect to your own remote LND">
      <p style={{ color: '#9aa0a6' }}>
        Instead of running a bundled node, this desktop wallet can act as a UI for a Lightning
        node you control elsewhere (LND ≥ v0.19.0 with RPC middleware enabled).
      </p>
      <p style={{ color: '#9aa0a6' }}>
        Connection credentials (host, TLS certificate, admin macaroon) stay out of the webview —
        they are passed to the node bridge process at launch, which holds them in memory only.
      </p>
      <pre
        data-testid="remote-node-usage"
        style={{ background: '#141418', border: '1px solid #2a2a30', borderRadius: 8, padding: 12, fontSize: 12, overflowX: 'auto' }}
      >{`sovereign-litd-bridge \\
  --assume-running \\
  --dataDir=/path/to/node-data \\
  --backend=remote-lnd \\
  --remoteRpcServer=your-node.example.com:10009 \\
  --remoteTlsCert=/path/to/tls.cert \\
  --remoteMacaroon=/path/to/admin.macaroon`}</pre>
      <p style={{ color: '#9aa0a6', fontSize: 13 }}>
        Launch the app through that bridge and this wallet becomes a window onto your own node:
        balances, channels, and payments all read and act on the remote LND. The bundled-node
        mode (Overview tab) stays untouched — a remote connection is a separate wallet identity,
        never merged with a local one.
      </p>
    </Card>
  );
}
