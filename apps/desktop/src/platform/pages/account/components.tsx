/**
 * Small building blocks shared by the account, Taproot Assets and Pool pages.
 * Built only from kit classes and --sovl-* tokens (see account.css).
 */
import { useState, type ReactNode } from 'react';
import { usePrefs } from '../../context.js';
import { Icon, shortId } from '../../ui.js';
import './account.css';

/** Label/value list. `compact` right-aligns values for narrow side panels. */
export function Facts({ children, compact }: { children: ReactNode; compact?: boolean }) {
  return <dl className={`ac-facts ${compact ? 'ac-facts-compact' : ''}`}>{children}</dl>;
}

export function Fact({ label, help, children, testId }: { label: ReactNode; help?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <div className="ac-fact" data-testid={testId}>
      <dt>{label}</dt>
      <dd>
        {children}
        {help ? <div className="ac-fact-help">{help}</div> : null}
      </dd>
    </div>
  );
}

/** Copy button that keeps its name and confirms in text. */
export function CopyButton({ value, label = 'Copy', ariaLabel }: { value: string; label?: string; ariaLabel?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="p-btn p-btn-ghost p-btn-sm"
      aria-label={ariaLabel}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      <Icon name={copied ? 'check' : 'copy'} />
      {copied ? 'Copied' : label}
    </button>
  );
}

/** A long identifier shown shortened, with the full value in a tooltip and a copy button. */
export function IdCopy({ value, what, head = 10, tail = 8 }: { value: string; what: string; head?: number; tail?: number }) {
  if (value === '') return <span className="p-faint">None</span>;
  return (
    <span className="ac-inline-copy">
      <span className="p-mono" title={value}>
        {shortId(value, head, tail)}
      </span>
      <CopyButton value={value} ariaLabel={`Copy ${what}`} />
    </span>
  );
}

/** A section a daemon could not answer: says so, and keeps the raw error text. */
export function Unavailable({ title, children, raw }: { title: ReactNode; children?: ReactNode; raw?: string }) {
  return (
    <div className="ac-unavail" role="status">
      <div className="ac-unavail-title">
        <Icon name="info" />
        {title}
      </div>
      {children ? <div>{children}</div> : null}
      {raw ? (
        <details className="ac-raw-details">
          <summary>Error details</summary>
          <div className="ac-raw">{raw}</div>
        </details>
      ) : null}
    </div>
  );
}

/** Taproot asset units (not sats). Respects the amount-privacy preference. */
export function Units({ value, unit = 'units', className }: { value: string | null | undefined; unit?: string; className?: string }) {
  const { hideAmounts } = usePrefs();
  if (value === null || value === undefined || !/^[0-9]+$/.test(value)) return <span className={className}>—</span>;
  if (hideAmounts) {
    return (
      <span className={`p-hidden-amount ${className ?? ''}`} aria-label="Amount hidden">
        ••••••
      </span>
    );
  }
  return (
    <span className={className}>
      {BigInt(value).toLocaleString('en-US')}
      {unit ? <span className="p-faint"> {unit}</span> : null}
    </span>
  );
}

/** Blocks → rough wall-clock duration at ~10 min per block (labelled as approximate by callers). */
export function blocksToText(blocks: number): string {
  const minutes = blocks * 10;
  if (minutes < 120) return `${minutes} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${Math.round(hours)} h`;
  const days = hours / 24;
  if (days < 60) return `${Math.round(days)} days`;
  return `${Math.round(days / 30)} months`;
}

export function sentence(s: string): string {
  const t = s.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}
