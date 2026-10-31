/**
 * Append-only audit trail for liquidity actions. Every automated action,
 * policy change, and budget block is journaled so automation stays
 * recoverable and reconcilable after interruption — per the spec's
 * "every automated action is journaled" requirement.
 */

export type LiquidityActionKind =
  /** A quote was fetched (price seen by the user or the automation). */
  | 'quote'
  /** A user-initiated swap started or settled. */
  | 'manual-swap'
  /** An AutoLoop-dispatched swap started or settled. */
  | 'auto-swap'
  /** AutoLoop enabled/disabled or parameters changed. */
  | 'policy-change'
  /** An automated action was refused or automation disabled by budget policy. */
  | 'budget-block';

/** JSON-serializable extra details for a journal entry. */
export type LiquidityJournalData = Record<string, string | number | boolean | null>;

export interface LiquidityJournalEntry {
  id: string;
  /** ISO-8601 UTC timestamp. */
  at: string;
  kind: LiquidityActionKind;
  /** Human-readable one-liner. */
  message: string;
  data?: LiquidityJournalData;
}

/**
 * Persistence port. A production implementation backs this with
 * SQLCipher-at-rest SQLite (wired by the app); tests and headless flows use
 * `MemoryLiquidityJournal`.
 */
export interface LiquidityJournal {
  append(entry: Readonly<LiquidityJournalEntry>): Promise<void>;
  /** Entries in append order (oldest first). */
  list(): Promise<LiquidityJournalEntry[]>;
}

/** Snapshot-semantics in-memory journal for tests and transient runs. */
export class MemoryLiquidityJournal implements LiquidityJournal {
  private readonly entries: LiquidityJournalEntry[] = [];

  async append(entry: Readonly<LiquidityJournalEntry>): Promise<void> {
    this.entries.push(cloneEntry(entry));
  }

  async list(): Promise<LiquidityJournalEntry[]> {
    return this.entries.map(cloneEntry);
  }
}

function cloneEntry(entry: Readonly<LiquidityJournalEntry>): LiquidityJournalEntry {
  return JSON.parse(JSON.stringify(entry)) as LiquidityJournalEntry;
}
