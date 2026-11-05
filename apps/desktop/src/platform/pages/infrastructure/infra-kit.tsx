/** Helpers shared by the Infrastructure pages (node, network, routing, connections). */
import type { ReactNode } from 'react';
import { BridgeHttpError } from '../../../modeb/bridge-client.js';
import { Notice } from '../../ui.js';
import './infrastructure.css';

export function errorText(err: unknown): string {
  if (err instanceof BridgeHttpError) {
    return err.status === 0 ? `The local node bridge is unreachable (${err.message}). Check that the node is running, then retry.` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export function LoadError({ what, error, onRetry }: { what: string; error: string; onRetry: () => void }) {
  return (
    <Notice
      tone="danger"
      title={`Couldn't load ${what}`}
      action={
        <button type="button" className="p-btn p-btn-sm" onClick={onRetry}>
          Retry
        </button>
      }
    >
      {error}
    </Notice>
  );
}

/** Label / value rows (non-amount values right-aligned). */
export function KV({ rows }: { rows: readonly { label: ReactNode; value: ReactNode; mono?: boolean; hint?: ReactNode }[] }) {
  return (
    <dl className="in-kv">
      {rows.map((r, i) => (
        <div key={i}>
          <dt>
            {r.label}
            {r.hint ? <div className="p-hint">{r.hint}</div> : null}
          </dt>
          <dd className={r.mono ? 'p-mono' : undefined}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 min';
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/** lnd forwarding timestamps arrive in ns; older nodes report seconds. Returns epoch ms. */
export function forwardTimeMs(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n > 1e15) return Math.floor(n / 1e6); // ns
  if (n > 1e12) return n; // ms
  return n * 1000; // s
}

export const msatToSat = (msat: string | number): number => Number(msat) / 1000;

export const SUB_SERVER_INFO: Record<string, { name: string; role: string }> = {
  lnd: { name: 'lnd', role: 'Lightning node: wallet, channels, payments' },
  lit: { name: 'Lightning Terminal', role: 'Runs and coordinates the other services' },
  loop: { name: 'Loop', role: 'Swaps between on-chain and Lightning' },
  pool: { name: 'Pool', role: 'Marketplace for buying and selling channel leases' },
  'taproot-assets': { name: 'Taproot Assets (tapd)', role: 'Issue and hold assets on bitcoin and Lightning' },
  faraday: { name: 'Faraday', role: 'Channel analytics and revenue reports' },
  accounts: { name: 'Accounts', role: 'Off-chain spending accounts for apps connected to this node' },
};
