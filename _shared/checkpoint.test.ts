import { assertEquals, assertThrows } from 'https://deno.land/std@0.177.0/testing/asserts.ts'
import { computeLedgerRange } from './checkpoint.ts'
import type { Checkpoint } from './checkpoint.ts'

Deno.test('computeLedgerRange - caught up returns skipped with caught-up reason', () => {
  const checkpoint: Checkpoint = { lastProcessedLedger: 100 }
  const result = computeLedgerRange(checkpoint, 100, 1)

  assertEquals(result?.status, 'skipped')
  assertEquals(result?.reason, 'caught-up')
  assertEquals(result?.from, 101)
  assertEquals(result?.to, 100)
})

Deno.test('computeLedgerRange - tip regression returns skipped with tip-regression reason', () => {
  const checkpoint: Checkpoint = { lastProcessedLedger: 100 }
  const result = computeLedgerRange(checkpoint, 90, 1)

  assertEquals(result?.status, 'skipped')
  assertEquals(result?.reason, 'tip-regression')
  assertEquals(result?.from, 101)
  assertEquals(result?.to, 100)
})

Deno.test('computeLedgerRange - normal processing returns valid range', () => {
  const checkpoint: Checkpoint = { lastProcessedLedger: 100 }
  const result = computeLedgerRange(checkpoint, 110, 1)

  assertEquals(result?.status, 'processing')
  assertEquals(result?.from, 101)
  assertEquals(result?.to, 110)
})

Deno.test('computeLedgerRange - no checkpoint starts from startLedger', () => {
  const result = computeLedgerRange(null, 50, 10)

  assertEquals(result?.status, 'processing')
  assertEquals(result?.from, 10)
  assertEquals(result?.to, 50)
})

Deno.test('computeLedgerRange - no checkpoint and caught up', () => {
  const result = computeLedgerRange(null, 9, 10)

  assertEquals(result?.status, 'skipped')
  assertEquals(result?.reason, 'caught-up')
  assertEquals(result?.from, 10)
  assertEquals(result?.to, 9)
})

Deno.test('computeLedgerRange - no checkpoint and tip regression', () => {
  const result = computeLedgerRange(null, 5, 10)

  assertEquals(result?.status, 'skipped')
  assertEquals(result?.reason, 'tip-regression')
  assertEquals(result?.from, 10)
  assertEquals(result?.to, 9)
})
