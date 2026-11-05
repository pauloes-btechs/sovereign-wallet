import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { sovlColors, sovlFontFamily, sovlFontSize, sovlRadius, sovlSpace } from './tokens.js';

/** Reads every `--sovl-*` declaration from the first (`:root`) block of styles.css. */
function cssTokens(): Map<string, string> {
  // Vitest blanks CSS modules (even `?raw`), so read the file itself.
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  const start = css.indexOf('{');
  const end = css.indexOf('}', start);
  const block = css.slice(start + 1, end).replace(/\/\*[\s\S]*?\*\//g, '');
  const tokens = new Map<string, string>();
  for (const match of block.matchAll(/--sovl-([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) {
      tokens.set(name, value.replace(/\s+/g, ' ').trim());
    }
  }
  return tokens;
}

const kebab = (key: string): string => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

describe('TS design tokens match styles.css', () => {
  const tokens = cssTokens();

  it('finds the CSS tokens', () => {
    expect(tokens.size).toBeGreaterThan(30);
  });

  it('colors', () => {
    for (const [key, value] of Object.entries(sovlColors)) {
      expect(tokens.get(kebab(key)), key).toBe(value);
    }
  });

  it('radii, type scale and spacing', () => {
    expect(tokens.get('radius')).toBe(`${sovlRadius.md}px`);
    expect(tokens.get('radius-sm')).toBe(`${sovlRadius.sm}px`);
    expect(tokens.get('radius-xs')).toBe(`${sovlRadius.xs}px`);
    for (const [key, value] of Object.entries(sovlFontSize)) {
      expect(tokens.get(`text-${key}`), key).toBe(`${value}px`);
    }
    for (const [key, value] of Object.entries(sovlSpace)) {
      expect(tokens.get(`space-${key}`), key).toBe(`${value}px`);
    }
  });

  it('font stacks', () => {
    expect(tokens.get('font')).toBe(sovlFontFamily.sans);
    expect(tokens.get('mono')).toBe(sovlFontFamily.mono);
  });
});
