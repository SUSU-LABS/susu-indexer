/**
 * Checkpoint and ledger-range handling.
 *
 * The indexer persists the last fully processed ledger so that a missed or
 * failed scheduled run is safely retryable. Two rules matter:
 *
 * 1. A checkpoint only moves forward. Regressing it would re-index events, and
 *    while upserts are idempotent, a regression also risks masking a gap.
 * 2. A checkpoint is only advanced after the corresponding range has been
 *    written successfully. Advancing early would silently skip events.
 *
 * Ranges are bounded so a single invocation stays within its execution budget;
 * the next run resumes from the checkpoint. No ledger is ever skipped between
 * consecutive runs.
 */

export type Checkpoint = {
  /** Highest ledger whose events have been fully persisted. */
  lastProcessedLedger: number;
  /** Ledger at which indexing last (re)started. Used for full rebuilds. */
  startLedger: number;
  /** When the checkpoint was last advanced (ISO 8601). */
  updatedAt: string;
};

export type LedgerRange = {
  /** First ledger to process (inclusive). */
  from: number;
  /** Last ledger to process (inclusive). */
  to: number;
  /** True when the range was capped before reaching the chain head. */
  truncated: boolean;
};

/**
 * Computes the next ledger range to process.
 *
 * On a first run (`lastProcessedLedger === null`) indexing begins at
 * `startLedger`, which is the ledger the contracts were deployed at. On later
 * runs it resumes immediately after the checkpoint, so no ledger is skipped.
 *
 * A `startLedger` raised above the checkpoint (`startLedger >
 * lastProcessedLedger + 1`) never advances the range: the indexer resumes
 * after the checkpoint, and `onStartLedgerIgnored` is invoked so the caller
 * can warn loudly. Raising the start ledger used to silently carve a permanent
 * gap in the index; the documented rebuild procedure (resetting
 * `last_processed_ledger` to `start_ledger - 1`) is unaffected because there
 * `startLedger` equals exactly `lastProcessedLedger + 1`.
 *
 * Returns `null` when the indexer is already caught up to the chain head.
 * Throws on invalid input rather than guessing — a bad range could skip ledgers.
 */
export function computeLedgerRange(params: {
  lastProcessedLedger: number | null;
  latestLedger: number;
  startLedger: number;
  maxRange: number;
  /**
   * Invoked when an existing checkpoint makes `startLedger` irrelevant because
   * honouring it would skip ledgers. The caller should log this prominently:
   * someone raised the start ledger expecting it to take effect.
   */
  onStartLedgerIgnored?: (detail: {
    startLedger: number;
    resumedFrom: number;
  }) => void;
}): LedgerRange | null {
  const { lastProcessedLedger, latestLedger, startLedger, maxRange } = params;

  if (!Number.isSafeInteger(latestLedger) || latestLedger < 0) {
    throw new Error('latestLedger must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(startLedger) || startLedger < 0) {
    throw new Error('startLedger must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(maxRange) || maxRange <= 0) {
    throw new Error('maxRange must be a positive safe integer');
  }
  if (lastProcessedLedger !== null) {
    if (!Number.isSafeInteger(lastProcessedLedger) || lastProcessedLedger < 0) {
      throw new Error('lastProcessedLedger must be null or a non-negative safe integer');
    }
  }

  // `startLedger` is honoured only when there is no checkpoint. Once a
  // checkpoint exists, resuming after it is the only way to avoid skipping
  // ledgers; a raised start ledger is ignored loudly rather than obeyed
  // silently.
  const from = lastProcessedLedger === null ? startLedger : lastProcessedLedger + 1;

  if (
    lastProcessedLedger !== null &&
    startLedger > lastProcessedLedger + 1
  ) {
    params.onStartLedgerIgnored?.({
      startLedger,
      resumedFrom: from,
    });
  }

  if (from > latestLedger) return null;

  const to = Math.min(latestLedger, from + maxRange - 1);
  return { from, to, truncated: to < latestLedger };
}

/**
 * Decides whether a candidate checkpoint may advance the stored one.
 *
 * Returns `false` for equal or lower ledgers, so a retried run is a no-op rather
 * than a regression.
 */
export function canAdvanceCheckpoint(
  current: Checkpoint | undefined,
  candidate: number,
): boolean {
  if (!Number.isInteger(candidate) || candidate < 0) return false;
  if (current === undefined) return true;
  return candidate > current.lastProcessedLedger;
}

/**
 * Computes the ledger lag between the chain tip and the checkpoint.
 *
 * Used for monitoring: a steadily growing lag means scheduled runs are not
 * keeping up, or are failing. `undefined` means the indexer has never run.
 */
export function ledgerLag(
  current: Checkpoint | undefined,
  latestLedger: number,
): number | undefined {
  if (current === undefined) return undefined;
  return Math.max(0, latestLedger - current.lastProcessedLedger);
}
