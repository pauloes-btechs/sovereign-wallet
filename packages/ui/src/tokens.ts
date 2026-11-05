/**
 * Design tokens as TypeScript values — the same palette, type scale, spacing
 * and radii that `styles.css` declares as `--sovl-*` custom properties, for
 * surfaces that cannot read CSS variables (React Native on mobile).
 *
 * `styles.css` stays the source for the DOM; `tokens.test.ts` parses it and
 * fails if any value here drifts from the CSS.
 */

export const sovlColors = {
  /** App background. */
  bg: '#0b0d12',
  /** Sidebar / tab bar — one step above the background. */
  sidebar: '#10131a',
  /** Panels and cards. */
  surface: '#161b24',
  /** Menus, sheets, inputs. */
  surfaceRaised: '#1d2430',
  border: '#232a36',
  borderStrong: '#2f3847',
  text: '#f5f7fa',
  textSecondary: '#9ca6b5',
  textFaint: '#6b7686',
  /** Bitcoin amber — primary actions and Lightning-spendable funds only. */
  accent: '#f7931a',
  accentHover: '#ffa640',
  accentContrast: '#1a1206',
  accentSoft: 'rgba(247, 147, 26, 0.12)',
  positive: '#52b788',
  warning: '#d4a548',
  danger: '#dc6b63',
  info: '#7a9fe0',
  fundOnchain: '#7286a8',
  fundOutbound: '#f7931a',
  fundInbound: '#3e9e98',
  fundLocked: '#4a5466',
} as const;

export const sovlRadius = {
  md: 12,
  sm: 8,
  xs: 6,
} as const;

/** Type scale (major third on 14px), in px. */
export const sovlFontSize = {
  xs: 12,
  sm: 13,
  md: 14,
  lg: 17,
  xl: 22,
  '2xl': 28,
  '3xl': 36,
} as const;

/** Spacing on a 4px base, in px. */
export const sovlSpace = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 24,
  6: 32,
  7: 48,
} as const;

/** Font stacks (CSS syntax) — web surfaces only; native uses the system face. */
export const sovlFontFamily = {
  sans: "'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace",
} as const;

export type SovlColor = keyof typeof sovlColors;
