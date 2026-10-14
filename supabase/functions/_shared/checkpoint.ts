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
 * Once a checkpoint exists, `startLedger` is not consulted at all. It used to
 * be: the range began at `max(lastProcessedLedger + 1, startLedger)`, so a
 * start ledger raised above the checkpoint (in `INDEXER_START_LEDGER` or in
 * `indexer_checkpoints.start_ledger`) moved the range forward and left every
 * ledger in between unread, permanently and without a word. A raised start
 * ledger is now ignored, and `startLedgerGap` tells the caller when that
 * happened so the run can say so. Moving the indexer to another ledger on
 * purpose is the rebuild in `docs/RUNBOOK.md`, which resets both columns
 * together.
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

  const from = lastProcessedLedger === null ? startLedger : lastProcessedLedger + 1;

  if (from > latestLedger) return null;

  const to = Math.min(latestLedger, from + maxRange - 1);
  return { from, to, truncated: to < latestLedger };
}

/** The ledgers a raised start ledger would have skipped, had it been honoured. */
export type StartLedgerGap = {
  /** The start ledger that was configured. */
  startLedger: number;
  /** Where the run resumes instead: immediately after the checkpoint. */
  resumeFrom: number;
  /** First ledger that would have been skipped (inclusive). */
  skippedFrom: number;
  /** Last ledger that would have been skipped (inclusive). */
  skippedTo: number;
};

/**
 * Detects a start ledger raised above an existing checkpoint.
 *
 * Returns `null` on a first run (there is no checkpoint to skip past), when the
 * start ledger is at or below the resume point, and for the documented rebuild,
 * which sets `last_processed_ledger` to `start_ledger - 1` so the two agree
 * exactly. Otherwise it describes the gap that honouring the start ledger would
 * have opened, so the caller can warn with the ledgers at stake rather than a
 * bare "ignored".
 */
export function startLedgerGap(params: {
  lastProcessedLedger: number | null;
  startLedger: number;
}): StartLedgerGap | null {
  const { lastProcessedLedger, startLedger } = params;
  if (lastProcessedLedger === null) return null;

  const resumeFrom = lastProcessedLedger + 1;
  if (startLedger <= resumeFrom) return null;

  return { startLedger, resumeFrom, skippedFrom: resumeFrom, skippedTo: startLedger - 1 };
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
