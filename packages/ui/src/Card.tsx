import type { ReactNode } from 'react';

export interface CardProps {
  title?: string;
  children: ReactNode;
  className?: string;
}

/** Surface container for a single wallet concern. */
export function Card({ title, children, className }: CardProps) {
  return (
    <section className={className ? `sovl-card ${className}` : 'sovl-card'}>
      {title ? <h2 className="sovl-card-title">{title}</h2> : null}
      {children}
    </section>
  );
}
