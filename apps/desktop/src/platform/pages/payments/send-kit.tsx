/**
 * Small helpers shared by the Send, Receive and Payment requests pages.
 * Nothing here computes balances or invents values.
 */
import { useState, type ReactNode } from 'react';
import { BridgeHttpError } from '../../../modeb/bridge-client.js';
import type { InvoiceView } from '../../api.js';
import { Badge, Icon, type Tone } from '../../ui.js';
import { unactivatedAddressProblem } from './address-guard.js';
import './send.css';

export function errorText(err: unknown): string {
  if (err instanceof BridgeHttpError) {
    return err.status === 0 ? `The local node bridge is unreachable (${err.message}). Check that the node is running, then retry.` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Parse a typed sats amount (commas allowed). undefined when blank; throws on junk. */
export function parseSats(raw: string): number | undefined {
  const t = raw.trim().replace(/[,_\s]/g, '');
  if (t === '') return undefined;
  if (!/^\d+$/.test(t)) throw new Error('Enter a whole number of sats (no decimals).');
  const n = Number(t);
  if (!Number.isSafeInteger(n)) throw new Error('That amount is too large.');
  return n;
}

/** Same as parseSats but returns an error string instead of throwing. */
export function readSats(raw: string): { value?: number; error?: string } {
  try {
    return { value: parseSats(raw) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * A long identifier (address, invoice, txid) with a copy button. Unlike the
 * kit's CopyField, the value element can carry a test id and holds ONLY the
 * value, so its textContent is exactly the string.
 */
export function CopyValue({ value, label, testId, clamp }: { value: string; label: string; testId?: string; clamp?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="p-copy">
      <code aria-label={label} data-testid={testId} className={clamp ? 'sw-clamp' : undefined}>
        {value}
      </code>
      <button
        type="button"
        className="p-btn p-btn-ghost p-btn-sm"
        aria-label={`Copy ${label.toLowerCase()}`}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        <Icon name={copied ? 'check' : 'copy'} />
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export type InvoiceStatus = 'open' | 'expired' | 'settled' | 'canceled' | 'accepted';

/** Invoice state as the user sees it: an open invoice past its expiry is expired. */
export function invoiceStatus(inv: InvoiceView, now = Date.now()): InvoiceStatus {
  if (inv.state === 'open' && inv.expiresAt > 0 && inv.expiresAt <= now) return 'expired';
  return inv.state;
}

const STATUS_TONE: Record<InvoiceStatus, Tone> = {
  open: 'info',
  expired: 'neutral',
  settled: 'positive',
  canceled: 'danger',
  accepted: 'warning',
};

const STATUS_LABEL: Record<InvoiceStatus, string> = {
  open: 'Awaiting payment',
  expired: 'Expired',
  settled: 'Paid',
  canceled: 'Canceled',
  accepted: 'Held (accepted)',
};

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>;
}

export function invoiceStatusLabel(status: InvoiceStatus): string {
  return STATUS_LABEL[status];
}

/** "in 23 h", "in 4 min", "expired" */
export function timeUntil(ms: number, now = Date.now()): string {
  const s = Math.round((ms - now) / 1000);
  if (s <= 0) return 'expired';
  if (s < 90) return `in ${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `in ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `in ${h} h`;
  return `in ${Math.round(h / 24)} d`;
}

export function dateTime(ms: number): string {
  return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Key/value rows for non-amount details (left label, right value). */
export function Details({ rows }: { rows: readonly { label: ReactNode; value: ReactNode; mono?: boolean }[] }) {
  return (
    <dl className="sw-details">
      {rows.map((r, i) => (
        <div key={i} className="sw-details-row">
          <dt>{r.label}</dt>
          <dd className={r.mono ? 'p-mono' : undefined}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Network-specific address prefixes, for an early, friendly sanity check. lnd validates for real. */
export function addressLooksWrong(address: string, network: string | undefined): string | null {
  const a = address.trim();
  if (a === '') return 'Enter a Bitcoin address.';
  if (/\s/.test(a)) return 'Addresses contain no spaces.';
  if (/^ln/i.test(a)) return 'That looks like a Lightning invoice. Use the Lightning tab to pay it.';
  if (/^bitcoin:/i.test(a)) return 'Paste just the address, without the "bitcoin:" prefix.';
  const lower = a.toLowerCase();
  const expect: Record<string, readonly string[]> = {
    mainnet: ['bc1', '1', '3'],
    testnet: ['tb1', 'm', 'n', '2'],
    signet: ['tb1', 'm', 'n', '2'],
    regtest: ['bcrt1', 'm', 'n', '2'],
  };
  const prefixes = network === undefined ? undefined : expect[network];
  if (prefixes !== undefined && !prefixes.some((p) => lower.startsWith(p))) {
    return `This doesn't look like a ${network} address (expected it to start with ${prefixes.join(', ')}).`;
  }
  return unactivatedAddressProblem(a);
}
