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

/**
 * Checks a phrase the user typed back in full (words separated by any
 * whitespace). A missing or extra word is a mismatch at that position.
 */
export function verifyRetypedPhrase(words: readonly string[], typed: string): WordCheckResult {
  const entered = typed.trim().split(/\s+/).filter((w) => w.length > 0);
  const result = verifyWordInputs(words, words.map((_, index) => ({ index, text: entered[index] ?? '' })));
  if (!result.correct || entered.length === words.length) return result;
  return { correct: false, firstMismatch: words.length };
}
