/**
 * Channel helpers shared by the channel manager page and its detail sheet.
 */
import { BridgeHttpError, type ChannelRowView } from '../../../modeb/bridge-client.js';
import { Amount, Badge, type Tone } from '../../ui.js';
import './channels.css';

export function errorText(err: unknown): string {
  if (err instanceof BridgeHttpError) {
    return err.status === 0 ? `The local node bridge is unreachable (${err.message}). Check that the node is running, then retry.` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export const STATE_TONE: Record<ChannelRowView['state'], Tone> = {
  open: 'positive',
  'open-inactive': 'warning',
  opening: 'info',
  closing: 'warning',
  'closing-force': 'danger',
  'waiting-close': 'warning',
};

export const STATE_LABEL: Record<ChannelRowView['state'], string> = {
  open: 'Active',
  'open-inactive': 'Peer offline',
  opening: 'Opening',
  closing: 'Closing',
  'closing-force': 'Force closing',
  'waiting-close': 'Waiting to close',
};

export function StateBadge({ state }: { state: ChannelRowView['state'] }) {
  return <Badge tone={STATE_TONE[state]}>{STATE_LABEL[state]}</Badge>;
}

/** The bridge's plain-language note for a row; limbo amounts rendered as amounts. */
export function RowNote({ label }: { label: string }) {
  const m = /^funds in limbo: (\d+) sat$/.exec(label);
  if (m) {
    return (
      <span>
        funds in limbo: <Amount sats={m[1]} />
      </span>
    );
  }
  return <span>{label}</span>;
}

/** Short channel id (block x tx x output) decoded from lnd's uint64 chan id. */
export function scid(chanId: string): string | null {
  if (!/^\d+$/.test(chanId) || chanId === '0') return null;
  const v = BigInt(chanId);
  const block = v >> 40n;
  const tx = (v >> 16n) & 0xffffffn;
  const out = v & 0xffffn;
  return `${block}x${tx}x${out}`;
}

/** Routing fee earned for forwarding `amountSat`, from a base fee (msat) and a proportional rate (ppm). */
export function forwardFeeSat(amountSat: number, baseFeeMsat: number, feePpm: number): number {
  return (baseFeeMsat + (amountSat * 1000 * feePpm) / 1_000_000) / 1000;
}

export function formatMsatAsSats(msat: number): string {
  const sats = msat / 1000;
  return Number.isInteger(sats) ? sats.toLocaleString('en-US') : sats.toLocaleString('en-US', { maximumFractionDigits: 3 });
}

/** Compact local/remote split for a table row. */
export function SplitBar({ local, remote }: { local: number; remote: number }) {
  const total = local + remote;
  const pct = total === 0 ? 0 : (local / total) * 100;
  return (
    <div className="ch-split" role="img" aria-label={`Local ${local} sats, remote ${remote} sats`}>
      <div className="ch-split-bar">
        {total > 0 ? (
          <>
            {local > 0 ? <span className="p-lbar-seg" data-fund="outbound" style={{ flexGrow: local }} /> : null}
            {remote > 0 ? <span className="p-lbar-seg" data-fund="inbound" style={{ flexGrow: remote }} /> : null}
          </>
        ) : null}
      </div>
      <div className="ch-split-nums">
        <span>
          <Amount sats={local} showUnit={false} />
        </span>
        <span className="p-faint">{total === 0 ? '' : `${Math.round(pct)}% local`}</span>
        <span>
          <Amount sats={remote} showUnit={false} />
        </span>
      </div>
    </div>
  );
}
