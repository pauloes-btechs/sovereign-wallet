import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'positive' | 'warning' | 'danger' | 'info';

export interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
}

/** Small status pill. Tones map to the design-system state colors. */
export function Badge({ tone = 'neutral', children }: BadgeProps) {
  return (
    <span className={tone === 'neutral' ? 'sovl-badge' : `sovl-badge sovl-badge--${tone}`}>
      {children}
    </span>
  );
}
