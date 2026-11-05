/** CSS imports are handled by Vite/Storybook at bundle time. */
declare module '*.css';

/**
 * The token drift test reads styles.css from disk. It runs under Node (vitest),
 * but this package's program has no Node types — declare only what it uses.
 */
declare module 'node:fs' {
  export function readFileSync(path: URL, encoding: 'utf8'): string;
}

interface ImportMeta {
  readonly url: string;
}
