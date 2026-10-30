import type { ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export interface ButtonProps {
  variant?: ButtonVariant;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
}

/** Controlled button — the parent owns every behavior. */
export function Button({ variant = 'primary', disabled, onClick, children }: ButtonProps) {
  return (
    <button
      type="button"
      className={`sovl-button sovl-button--${variant}`}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
