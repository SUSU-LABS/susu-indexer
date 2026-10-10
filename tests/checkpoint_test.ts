import { assertEquals, assertThrows } from '@std/assert';
import {
  canAdvanceCheckpoint,
  type Checkpoint,
  classifyEmptyRange,
  computeLedgerRange,
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

// ---------------------------------------------------------------------------
// Empty-range classification
// ---------------------------------------------------------------------------

Deno.test('an empty range at the checkpoint is caught up, not a regression', () => {
  assertEquals(
    classifyEmptyRange({
      lastProcessedLedger: 5000,
      latestLedger: 5000,
      startLedger: 1000,
    }),
    { kind: 'caught-up' },
  );
});

Deno.test('a tip below the checkpoint is a tip regression with the distance', () => {
  assertEquals(
    classifyEmptyRange({
      lastProcessedLedger: 6000,
      latestLedger: 5900,
      startLedger: 1000,
    }),
    { kind: 'tip-regression', behindBy: 100 },
  );
});

Deno.test('a first-run tip below the deployment ledger is a tip regression', () => {
  // No checkpoint yet, and the provider cannot even see the ledger the
  // contracts were deployed at: wrong network or hopelessly stale.
  assertEquals(
    classifyEmptyRange({
      lastProcessedLedger: null,
      latestLedger: 400,
      startLedger: 1000,
    }),
    { kind: 'tip-regression', behindBy: 600 },
  );
});

Deno.test('a first-run tip at the deployment ledger is not regressed', () => {
  assertEquals(
    classifyEmptyRange({
      lastProcessedLedger: null,
      latestLedger: 1000,
      startLedger: 1000,
    }),
    { kind: 'caught-up' },
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

Deno.test('tip immediately below deployment ledger is not caught up', () => {
  assertEquals(
    classifyEmptyRange({ lastProcessedLedger: null, latestLedger: 999, startLedger: 1000 }),
    { kind: 'tip-regression', behindBy: 1 },
  );
});
