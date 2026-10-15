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
 * Returns `null` when the indexer is already caught up to the chain head.
 * Throws on invalid input rather than guessing — a bad range could skip ledgers.
 */
export function computeLedgerRange(params: {
  lastProcessedLedger: number | null;
  latestLedger: number;
  startLedger: number;
  maxRange: number;
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

  const from = lastProcessedLedger === null
    ? startLedger
    : Math.max(lastProcessedLedger + 1, startLedger);

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

/**
 * True when the chain head is behind the checkpoint rather than equal to it.
 *
 * `computeLedgerRange` returns `null` for both "caught up" and "the tip is
 * behind what we already indexed", and the two need different responses: one is
 * an idle healthy run, the other says the node answered from a stale replica or
 * the chain reorganised, so the next range may never include ledgers the
 * checkpoint claims are done. This keeps that distinction without widening the
 * range type every caller already unpacks.
 */
export function isTipRegression(params: {
  lastProcessedLedger: number | null;
  latestLedger: number;
}): boolean {
  if (params.lastProcessedLedger === null) return false;
  return params.latestLedger < params.lastProcessedLedger;
}
