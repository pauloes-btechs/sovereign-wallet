/**
 * Platform component kit. Every page builds from these; pages define no
 * colors or ad-hoc styles beyond layout. Amounts always render through
 * <Amount> so the privacy toggle and the sats/BTC unit apply everywhere.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import qrcode from 'qrcode-generator';
import { usePrefs } from './context.js';

// ——— icons (1.6px stroke, 24 grid) ———

const PATHS: Record<string, string> = {
  dashboard: 'M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-3H4zM14 7h6V4h-6z',
  activity: 'M3 12h4l3 7 4-14 3 7h4',
  accounts: 'M3 7h18v12H3zM3 11h18M7 15h3',
  send: 'M5 12h14M13 6l6 6-6 6',
  receive: 'M19 12H5M11 18l-6-6 6-6',
  swap: 'M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7',
  request: 'M7 3h10v18l-5-3-5 3zM10 8h4M10 12h4',
  liquidity: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z',
  loop: 'M17 8a6 6 0 1 0 1 6M18 3v5h-5',
  pool: 'M3 17c3-3 6 3 9 0s6 3 9 0M3 11c3-3 6 3 9 0s6 3 9 0',
  channels: 'M4 7h16M4 17h16M8 7v10M16 7v10',
  automation: 'M12 3v3M12 18v3M3 12h3M18 12h3M6 6l2 2M16 16l2 2M6 18l2-2M16 8l2-2M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z',
  bitcoin: 'M9 6h5a3 3 0 0 1 0 6H9zM9 12h6a3 3 0 0 1 0 6H9zM9 6v12M11 4v2M11 18v2M14 4v2M14 18v2',
  assets: 'M12 3 4 7.5v9L12 21l8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
  node: 'M4 5h16v6H4zM4 13h16v6H4zM8 8h.01M8 16h.01',
  network: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18',
  analytics: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  connections: 'M9 15 15 9M7.5 12.5l-2 2a3 3 0 0 0 4 4l2-2M16.5 11.5l2-2a3 3 0 0 0-4-4l-2 2',
  wallets: 'M4 7h14a2 2 0 0 1 2 2v9H4zM4 7l11-3v3M16 13h.01',
  security: 'M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z',
  privacy: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z',
  eyeOff: 'M3 3l18 18M10.6 6.1A10 10 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3.2 3.8M6.6 6.6A17 17 0 0 0 2 12s4 7 10 7a9.6 9.6 0 0 0 4.4-1',
  settings: 'M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  developer: 'M8 8l-4 4 4 4M16 8l4 4-4 4M13 5l-2 14',
  search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM20 20l-4-4',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  check: 'M5 12l5 5 9-10',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5v.01',
  warning: 'M12 3 2 20h20zM12 10v4M12 17v.01',
  error: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 9l6 6M15 9l-6 6',
  close: 'M6 6l12 12M18 6 6 18',
  chevronRight: 'M9 6l6 6-6 6',
  collapse: 'M15 6l-6 6 6 6',
  expand: 'M9 6l6 6-6 6',
  arrowDown: 'M12 5v14M6 13l6 6 6-6',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7z',
  chain: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  plus: 'M12 5v14M5 12h14',
  external: 'M14 4h6v6M20 4 10 14M18 14v6H4V6h6',
};

export function Icon({ name, label, size }: { name: keyof typeof PATHS | string; label?: string; size?: number }) {
  return (
    <svg
      className="p-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size}
      height={size}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path d={PATHS[name] ?? PATHS.info} />
    </svg>
  );
}

// ——— amounts ———

const SATS_PER_BTC = 100_000_000;

export function formatSats(sats: number | bigint | string, unit: 'sats' | 'btc'): string {
  const n = typeof sats === 'number' ? sats : Number(sats);
  if (!Number.isFinite(n)) return '—';
  if (unit === 'btc') {
    return (n / SATS_PER_BTC).toLocaleString('en-US', { minimumFractionDigits: 8, maximumFractionDigits: 8 });
  }
  return Math.round(n).toLocaleString('en-US');
}

/** Renders an amount in the viewer's unit; hidden when privacy mode is on. */
export function Amount({
  sats,
  unit: forced,
  sign,
  className,
  showUnit = true,
}: {
  sats: number | bigint | string | null | undefined;
  unit?: 'sats' | 'btc';
  sign?: '+' | '-';
  className?: string;
  showUnit?: boolean;
}) {
  const prefs = usePrefs();
  const unit = forced ?? prefs.unit;
  if (sats === null || sats === undefined) return <span className={className}>—</span>;
  if (prefs.hideAmounts) {
    return (
      <span className={`p-hidden-amount ${className ?? ''}`} aria-label="Amount hidden">
        ••••••
      </span>
    );
  }
  return (
    <span className={className}>
      {sign ?? ''}
      {formatSats(sats, unit)}
      {showUnit ? <span className="p-faint"> {unit === 'btc' ? 'BTC' : 'sats'}</span> : null}
    </span>
  );
}

// ——— liquidity bar ———

export type FundKind = 'onchain' | 'outbound' | 'inbound' | 'locked';

export const FUND_LABEL: Record<FundKind, string> = {
  onchain: 'On-chain',
  outbound: 'Lightning spendable',
  inbound: 'Lightning receivable',
  locked: 'Pending or locked',
};

export interface FundSegment {
  readonly kind: FundKind;
  readonly sats: number;
  readonly label?: string;
}

/** The signature element: where every sat sits, proportionally. */
export function LiquidityBar({
  segments,
  size = 'md',
  legend = true,
  ariaLabel,
}: {
  segments: readonly FundSegment[];
  size?: 'md' | 'lg';
  legend?: boolean;
  ariaLabel?: string;
}) {
  const total = segments.reduce((s, x) => s + Math.max(0, x.sats), 0);
  return (
    <div>
      <div
        className={`p-lbar ${size === 'lg' ? 'p-lbar-lg' : ''}`}
        role="img"
        aria-label={ariaLabel ?? segments.map((s) => `${s.label ?? FUND_LABEL[s.kind]} ${s.sats} sats`).join(', ')}
      >
        {total === 0 ? null : segments.filter((s) => s.sats > 0).map((s, i) => (
          <div key={`${s.kind}-${i}`} className="p-lbar-seg" data-fund={s.kind} style={{ flexGrow: s.sats }} title={s.label ?? FUND_LABEL[s.kind]} />
        ))}
      </div>
      {legend ? (
        <div className="p-legend">
          {segments.map((s, i) => (
            <div className="p-legend-item" key={`${s.kind}-${i}`}>
              <span className="p-legend-swatch p-lbar-seg" data-fund={s.kind} />
              <span className="p-legend-name">{s.label ?? FUND_LABEL[s.kind]}</span>
              <span className="p-legend-value">
                <Amount sats={s.sats} />
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ——— layout primitives ———

export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="p-page-head">
      <div>
        <h1 className="p-page-title">{title}</h1>
        {sub ? <p className="p-page-sub">{sub}</p> : null}
      </div>
      {actions ? <div className="p-actions">{actions}</div> : null}
    </header>
  );
}

export function Panel({
  title,
  note,
  actions,
  children,
  flush,
  className,
  testId,
}: {
  title?: ReactNode;
  note?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  flush?: boolean;
  className?: string;
  testId?: string;
}) {
  return (
    <section className={`p-panel ${flush ? 'p-panel-flush' : ''} ${className ?? ''}`} data-testid={testId}>
      {title || actions ? (
        <div className="p-panel-head">
          <div>
            {title ? <h2 className="p-panel-title">{title}</h2> : null}
            {note ? <div className="p-panel-note">{note}</div> : null}
          </div>
          {actions ? <div className="p-actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Stat({ label, children, foot }: { label: ReactNode; children: ReactNode; foot?: ReactNode }) {
  return (
    <div>
      <div className="p-stat-label">{label}</div>
      <div className="p-stat-value">{children}</div>
      {foot ? <div className="p-stat-foot">{foot}</div> : null}
    </div>
  );
}

export type Tone = 'positive' | 'warning' | 'danger' | 'info' | 'accent' | 'neutral';

export function Badge({ tone = 'neutral', children, plain }: { tone?: Tone; children: ReactNode; plain?: boolean }) {
  return (
    <span className="p-badge" data-tone={tone} data-plain={plain ? 'true' : undefined}>
      {children}
    </span>
  );
}

export function Notice({
  tone = 'info',
  title,
  children,
  action,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'positive';
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const icon = tone === 'danger' ? 'error' : tone === 'warning' ? 'warning' : tone === 'positive' ? 'check' : 'info';
  return (
    <div className="p-notice" data-tone={tone} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon name={icon} />
      <div>
        <div className="p-notice-title">{title}</div>
        {children ? <div className="p-notice-body">{children}</div> : null}
      </div>
      {action ?? <span />}
    </div>
  );
}

export function Empty({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="p-empty">
      <div className="p-empty-title">{title}</div>
      {children ? <div>{children}</div> : null}
      {action}
    </div>
  );
}

export function Skeleton({ height = 16, width = '100%' }: { height?: number; width?: number | string }) {
  return <div className="p-skeleton" style={{ height, width }} aria-hidden />;
}

// ——— forms ———

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="p-field">
      <label className="p-label" htmlFor={id}>
        {label}
      </label>
      {children(id)}
      {error ? <div className="p-error-text">{error}</div> : hint ? <div className="p-hint">{hint}</div> : null}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: string; disabled?: boolean }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="p-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} disabled={o.disabled} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ——— copy + QR ———

export function CopyField({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="p-copy">
      <code aria-label={label}>{value}</code>
      <button
        type="button"
        className="p-btn p-btn-ghost p-btn-sm"
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

/** QR code rendered locally (no network). `value` is encoded verbatim. */
export function QrCode({ value, size = 192, label }: { value: string; size?: number; label: string }) {
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();
  const count = qr.getModuleCount();
  const cell = size / count;
  const rects: string[] = [];
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) rects.push(`M${c * cell} ${r * cell}h${cell}v${cell}h-${cell}z`);
    }
  }
  return (
    <div className="p-qr">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label}>
        <path d={rects.join('')} fill="#0b0d12" shapeRendering="crispEdges" />
      </svg>
    </div>
  );
}

// ——— sheet (slide-over) ———

export function Sheet({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div className="p-scrim" onClick={onClose} />
      <aside className="p-sheet" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} tabIndex={-1} ref={ref}>
        <div className="p-sheet-head">
          <h2 className="p-panel-title">{title}</h2>
          <button type="button" className="p-btn p-btn-ghost p-btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="p-sheet-body">{children}</div>
      </aside>
    </>
  );
}

// ——— progress ———

export type StepState = 'done' | 'current' | 'pending' | 'failed';

export function Timeline({ items }: { items: readonly { title: ReactNode; body?: ReactNode; state: StepState }[] }) {
  return (
    <ol className="p-timeline">
      {items.map((it, i) => (
        <li key={i} data-state={it.state}>
          <span className="p-timeline-dot" />
          <div className="p-timeline-title">{it.title}</div>
          {it.body ? <div className="p-timeline-body">{it.body}</div> : null}
        </li>
      ))}
    </ol>
  );
}

export function Steps({ steps, current }: { steps: readonly string[]; current: number }) {
  return (
    <ol className="p-steps" aria-label="Progress">
      {steps.map((s, i) => (
        <li key={s} data-state={i < current ? 'done' : i === current ? 'current' : 'pending'} aria-current={i === current ? 'step' : undefined}>
          {s}
        </li>
      ))}
    </ol>
  );
}

/** Fee / cost breakdown with a total row. Values in sats. */
export function Breakdown({ rows, total }: { rows: readonly { label: ReactNode; sats: number | null; note?: ReactNode }[]; total?: { label: ReactNode; sats: number } }) {
  return (
    <dl className="p-dl">
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>
            {r.label}
            {r.note ? <div className="p-hint">{r.note}</div> : null}
          </dt>
          <dd>
            <Amount sats={r.sats} />
          </dd>
        </div>
      ))}
      {total ? (
        <>
          <dt className="p-dl-total">{total.label}</dt>
          <dd className="p-dl-total">
            <Amount sats={total.sats} />
          </dd>
        </>
      ) : null}
    </dl>
  );
}

// ——— time ———

export function relativeTime(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 90) return '1 min ago';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function shortId(id: string, head = 8, tail = 6): string {
  return id.length <= head + tail + 1 ? id : `${id.slice(0, head)}…${id.slice(-tail)}`;
}
