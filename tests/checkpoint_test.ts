import { assertEquals, assertThrows } from '@std/assert';
import {
  canAdvanceCheckpoint,
  type Checkpoint,
  computeLedgerRange,
  ledgerLag,
  startLedgerGap,
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
    { from: 1000, to: 1099, truncated: true },
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
    { from: 1100, to: 1199, truncated: true },
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
    lastProcessedLedger: first?.to ?? null,
    latestLedger: 10_000,
    startLedger: 500,
    maxRange: 250,
  });
  assertEquals(second?.from, (first?.to ?? 0) + 1);
});

Deno.test('the range is capped at the chain head and not marked truncated', () => {
  assertEquals(
    computeLedgerRange({
      lastProcessedLedger: 4990,
      latestLedger: 5000,
      startLedger: 1000,
      maxRange: 100,
    }),
    { from: 4991, to: 5000, truncated: false },
  );
});

Deno.test('a caught-up indexer returns no range', () => {
  assertEquals(
    computeLedgerRange({
      lastProcessedLedger: 5000,
      latestLedger: 5000,
      startLedger: 1000,
      maxRange: 100,
    }),
    null,
  );
});

Deno.test('a checkpoint ahead of the chain head returns no range', () => {
  assertEquals(
    computeLedgerRange({
      lastProcessedLedger: 6000,
      latestLedger: 5000,
      startLedger: 1000,
      maxRange: 100,
    }),
    null,
  );
});

Deno.test('the range never spans more than maxRange ledgers', () => {
  const range = computeLedgerRange({
    lastProcessedLedger: 10,
    latestLedger: 100_000,
    startLedger: 1,
    maxRange: 25,
  });
  assertEquals((range?.to ?? 0) - (range?.from ?? 0) + 1, 25);
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
// A start ledger raised above the checkpoint
// ---------------------------------------------------------------------------

Deno.test('a start ledger raised above the checkpoint never moves the range forward', () => {
  // Before: max(1099 + 1, 2000) = 2000, and ledgers 1100-1999 were never read.
  assertEquals(
    computeLedgerRange({
      lastProcessedLedger: 1099,
      latestLedger: 5000,
      startLedger: 2000,
      maxRange: 100,
    }),
    { from: 1100, to: 1199, truncated: true },
  );
});

Deno.test('a raised start ledger cannot make a caught-up indexer look behind', () => {
  assertEquals(
    computeLedgerRange({
      lastProcessedLedger: 5000,
      latestLedger: 5000,
      startLedger: 9000,
      maxRange: 100,
    }),
    null,
  );
});

Deno.test('startLedgerGap names the ledgers a raised start ledger would have skipped', () => {
  assertEquals(
    startLedgerGap({ lastProcessedLedger: 1099, startLedger: 2000 }),
    { startLedger: 2000, resumeFrom: 1100, skippedFrom: 1100, skippedTo: 1999 },
  );
  // Even one ledger ahead is a gap: resuming at 1101 would skip 1100.
  assertEquals(
    startLedgerGap({ lastProcessedLedger: 1099, startLedger: 1101 }),
    { startLedger: 1101, resumeFrom: 1100, skippedFrom: 1100, skippedTo: 1100 },
  );
});

Deno.test('startLedgerGap is silent on a first run', () => {
  assertEquals(startLedgerGap({ lastProcessedLedger: null, startLedger: 2000 }), null);
});

Deno.test('startLedgerGap is silent for the documented rebuild and a lower start ledger', () => {
  // The rebuild sets last_processed_ledger to start_ledger - 1: the two agree.
  assertEquals(startLedgerGap({ lastProcessedLedger: 1999, startLedger: 2000 }), null);
  // The steady state: the deployment ledger sits far below the checkpoint.
  assertEquals(startLedgerGap({ lastProcessedLedger: 1099, startLedger: 1000 }), null);
  assertEquals(startLedgerGap({ lastProcessedLedger: 1099, startLedger: 1100 }), null);
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
