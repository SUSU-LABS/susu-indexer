import { assertEquals, assertThrows } from '@std/assert';
import {
  canAdvanceCheckpoint,
  type Checkpoint,
  computeLedgerRange,
  type LedgerRangeResult,
  ledgerLag,
} from '../supabase/functions/_shared/checkpoint.ts';

function checkpoint(lastProcessedLedger: number, startLedger = 1): Checkpoint {
  return { lastProcessedLedger, startLedger, updatedAt: '2026-08-01T00:00:00.000Z' };
}

// ---------------------------------------------------------------------------
// Range computation
// ---------------------------------------------------------------------------

Deno.test('a first run starts at the configured deployment ledger', () => {
  assertEquals(
    computeLedgerRange({
      lastProcessedLedger: null,
      latestLedger: 5000,
      startLedger: 1000,
      maxRange: 100,
    }),
    { kind: 'range', range: { from: 1000, to: 1099, truncated: true } },
  );
});

Deno.test('a resumed run continues immediately after the checkpoint', () => {
  assertEquals(
    computeLedgerRange({
      lastProcessedLedger: 1099,
      latestLedger: 5000,
      startLedger: 1000,
      maxRange: 100,
    }),
    { kind: 'range', range: { from: 1100, to: 1199, truncated: true } },
  );
});

Deno.test('no ledger is ever skipped between consecutive runs', () => {
  const first = computeLedgerRange({
    lastProcessedLedger: null,
    latestLedger: 10_000,
    startLedger: 500,
    maxRange: 250,
  });
  const second = computeLedgerRange({
    lastProcessedLedger: first.kind === 'range' ? first.range.to : null,
    latestLedger: 10_000,
    startLedger: 500,
    maxRange: 250,
  });
  if (first.kind !== 'range' || second.kind !== 'range') {
    throw new Error('expected both runs to return a range');
  }
  assertEquals(second.range.from, first.range.to + 1);
});

Deno.test('the range is capped at the chain head and not marked truncated', () => {
  assertEquals(
    computeLedgerRange({
      lastProcessedLedger: 4990,
      latestLedger: 5000,
      startLedger: 1000,
      maxRange: 100,
    }),
    { kind: 'range', range: { from: 4991, to: 5000, truncated: false } },
  );
});

Deno.test('a caught-up indexer with a checkpoint reports caught_up', () => {
  assertEquals(
    computeLedgerRange({
      lastProcessedLedger: 5000,
      latestLedger: 5000,
      startLedger: 1000,
      maxRange: 100,
    }),
    { kind: 'caught_up' },
  );
});

Deno.test('a first run before the deployment ledger reports caught_up (deferred start)', () => {
  // No checkpoint yet and the chain head has not reached the deployment
  // ledger. There is nothing to do, and the operator has not misconfigured
  // anything: the contracts are simply not live yet.
  assertEquals(
    computeLedgerRange({
      lastProcessedLedger: null,
      latestLedger: 50,
      startLedger: 1000,
      maxRange: 100,
    }),
    { kind: 'caught_up' },
  );
});

Deno.test('a checkpoint ahead of the chain head reports tip_regression', () => {
  // The reported chain head is BEHIND the persisted checkpoint. This is the
  // case the indexer must surface, not silently skip.
  assertEquals(
    computeLedgerRange({
      lastProcessedLedger: 6000,
      latestLedger: 5000,
      startLedger: 1000,
      maxRange: 100,
    }),
    { kind: 'tip_regression' },
  );
});

Deno.test('a tip that is one ledger behind the checkpoint reports tip_regression', () => {
  // `from > latestLedger` covers both `from === latestLedger + 1` (caught up)
  // and `from > latestLedger + 1` (regression). The threshold is a regression
  // as soon as the tip is strictly below the checkpoint, not below
  // `checkpoint - 1`.
  assertEquals(
    computeLedgerRange({
      lastProcessedLedger: 5001,
      latestLedger: 5000,
      startLedger: 1000,
      maxRange: 100,
    }),
    { kind: 'tip_regression' },
  );
});

Deno.test('a first run with a tip behind startLedger is caught_up, not tip_regression', () => {
  // No checkpoint exists, so there is nothing to regress against. The
  // deployment ledger is simply in the future; this is the same kind of
  // "nothing to do" as a healthy catch-up.
  assertEquals(
    computeLedgerRange({
      lastProcessedLedger: null,
      latestLedger: 999,
      startLedger: 1000,
      maxRange: 100,
    }),
    { kind: 'caught_up' },
  );
});

Deno.test('the range never spans more than maxRange ledgers', () => {
  const result: LedgerRangeResult = computeLedgerRange({
    lastProcessedLedger: 10,
    latestLedger: 100_000,
    startLedger: 1,
    maxRange: 25,
  });
  if (result.kind !== 'range') {
    throw new Error('expected a range result');
  }
  assertEquals(result.range.to - result.range.from + 1, 25);
});

Deno.test('computeLedgerRange rejects invalid inputs', () => {
  for (
    const bad of [
      { maxRange: 0 },
      { maxRange: -1 },
      { latestLedger: -1 },
      { startLedger: -1 },
    ]
  ) {
    assertThrows(
      () =>
        computeLedgerRange({
          lastProcessedLedger: null,
          latestLedger: 100,
          startLedger: 1,
          maxRange: 10,
          ...bad,
        }),
      Error,
      undefined,
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

Deno.test('computeLedgerRange rejects a negative checkpoint', () => {
  assertThrows(() =>
    computeLedgerRange({
      lastProcessedLedger: -1,
      latestLedger: 100,
      startLedger: 1,
      maxRange: 10,
    })
  );
});

// ---------------------------------------------------------------------------
// Checkpoint advancement
// ---------------------------------------------------------------------------

Deno.test('canAdvanceCheckpoint allows the first checkpoint', () => {
  assertEquals(canAdvanceCheckpoint(undefined, 10), true);
});

Deno.test('canAdvanceCheckpoint allows a strictly greater ledger', () => {
  assertEquals(canAdvanceCheckpoint(checkpoint(10), 11), true);
});

Deno.test('canAdvanceCheckpoint rejects an equal ledger (replay is a no-op)', () => {
  assertEquals(canAdvanceCheckpoint(checkpoint(10), 10), false);
});

Deno.test('canAdvanceCheckpoint rejects a lower ledger (no regression)', () => {
  assertEquals(canAdvanceCheckpoint(checkpoint(10), 9), false);
});

Deno.test('canAdvanceCheckpoint rejects invalid ledgers', () => {
  assertEquals(canAdvanceCheckpoint(checkpoint(10), -1), false);
  assertEquals(canAdvanceCheckpoint(checkpoint(10), 1.5), false);
  assertEquals(canAdvanceCheckpoint(checkpoint(10), Number.NaN), false);
});

// ---------------------------------------------------------------------------
// Lag
// ---------------------------------------------------------------------------

Deno.test('ledgerLag is undefined before the first checkpoint', () => {
  assertEquals(ledgerLag(undefined, 100), undefined);
});

Deno.test('ledgerLag reports the distance from the chain tip', () => {
  assertEquals(ledgerLag(checkpoint(90), 100), 10);
});

Deno.test('ledgerLag never reports a negative lag', () => {
  assertEquals(ledgerLag(checkpoint(110), 100), 0);
});
