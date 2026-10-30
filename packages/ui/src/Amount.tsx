import { formatSats } from './copy.js';

export interface AmountProps {
  sats: bigint;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Render the "sats" unit suffix. Default: true. */
  unit?: boolean;
  className?: string;
}

/** Tabular, formatted satoshi amount. Purely presentational. */
export function Amount({ sats, size = 'md', unit = true, className }: AmountProps) {
  const classes = ['sovl-amount', `sovl-amount--${size}`, className]
    .filter((c): c is string => c !== undefined)
    .join(' ');
  return (
    <span className={classes}>
      {formatSats(sats)}
      {unit ? <span className="sovl-amount-suffix">sats</span> : null}
    </span>
  );
}
