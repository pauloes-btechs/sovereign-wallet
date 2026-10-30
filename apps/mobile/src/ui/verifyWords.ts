/**
 * Backup word verification — pure, exported for tests. The user re-enters the
 * words at fixed positions; a mismatch blocks the backup from completing.
 */

/** One re-entered word slot on the verify step. */
export interface WordEntry {
  readonly index: number;
  readonly text: string;
}

export interface WordCheckResult {
  readonly correct: boolean;
  /** The first slot that did not match; null when everything matched. */
  readonly firstMismatch: number | null;
}

/** Case- and whitespace-insensitive word comparison against the shown phrase. */
export function verifyWordInputs(
  words: readonly string[],
  entries: readonly WordEntry[],
): WordCheckResult {
  for (const entry of entries) {
    const expected = words[entry.index] ?? '';
    if (expected.toLowerCase() !== entry.text.trim().toLowerCase()) {
      return { correct: false, firstMismatch: entry.index };
    }
  }
  return { correct: true, firstMismatch: null };
}
