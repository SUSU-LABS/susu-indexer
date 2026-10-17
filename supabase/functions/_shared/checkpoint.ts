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
 * Discriminated union of every state `computeLedgerRange` can report.
 *
 * `tip_regression` is the case the indexer must surface to operators: the
 * reported chain head is *behind* the persisted checkpoint, which means
 * either the RPC endpoint is pointing at a lagging/wrong network, or the
 * checkpoint was loaded from a more advanced chain. Either way, indexing
 * must stop until the operator investigates — a "skip" here would mask
 * the misconfiguration and look healthy forever.
 */
export type LedgerRangeResult =
  | { kind: 'range'; range: LedgerRange }
  | { kind: 'caught_up' }
  | { kind: 'tip_regression' };

/**
 * Computes the next ledger range to process.
 *
 * On a first run (`lastProcessedLedger === null`) indexing begins at
 * `startLedger`, which is the ledger the contracts were deployed at. On later
 * runs it resumes immediately after the checkpoint, so no ledger is skipped.
 *
 * Three outcomes, distinguished so the caller cannot accidentally treat a
 * misconfigured RPC endpoint as a healthy idle:
 *
 * - `range`       — there is work to do; index `range.from`..`range.to`.
 * - `caught_up`   — `from === latestLedger + 1`; the indexer is healthy and
 *                   idle (or, on a first run, the deployment ledger has not
 *                   been reached yet).
 * - `tip_regression` — `latestLedger < lastProcessedLedger`; the reported
 *                   chain head is behind the persisted checkpoint. The
 *                   caller MUST surface this; it is a misconfiguration, not
 *                   an idle.
 *
 * Throws on invalid input rather than guessing — a bad range could skip
 * ledgers.
 */
export function computeLedgerRange(params: {
  lastProcessedLedger: number | null;
  latestLedger: number;
  startLedger: number;
  maxRange: number;
}): LedgerRangeResult {
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

  if (from > latestLedger) {
    // `from > latestLedger` covers two distinct cases. The caller's response
    // must differ: a tip regression is a misconfiguration that has to be
    // surfaced, while a genuine catch-up is the normal idle state.
    const isRegression = lastProcessedLedger !== null &&
      latestLedger < lastProcessedLedger;
    return isRegression
      ? { kind: 'tip_regression' }
      : { kind: 'caught_up' };
  }

  const to = Math.min(latestLedger, from + maxRange - 1);
  return {
    kind: 'range',
    range: { from, to, truncated: to < latestLedger },
  };
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
