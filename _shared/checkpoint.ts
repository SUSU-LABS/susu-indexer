import * as fs from 'fs'
import * as path from 'path'

export interface Checkpoint {
  lastProcessedLedger: number
}

export function loadCheckpoint(checkpointPath: string): Checkpoint | null {
  try {
    const data = fs.readFileSync(checkpointPath, 'utf-8')
    return JSON.parse(data) as Checkpoint
  } catch {
    return null
  }
}

export function saveCheckpoint(checkpointPath: string, checkpoint: Checkpoint): void {
  fs.mkdirSync(path.dirname(checkpointPath), { recursive: true })
  fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2))
}

export interface LedgerRange {
  from: number
  to: number
}

export function computeLedgerRange(
  checkpoint: Checkpoint | null,
  latestLedger: number,
  startLedger: number
): LedgerRange | null {
  const lastProcessedLedger = checkpoint?.lastProcessedLedger ?? startLedger - 1

  // Caught up: no ledger to process
  if (lastProcessedLedger === latestLedger) {
    console.log('Nothing to index: caught up')
    return { from: lastProcessedLedger + 1, to: lastProcessedLedger, status: 'skipped' as const, reason: 'caught-up' }
  }

  // Tip regression: reported tip is behind the checkpoint
  if (latestLedger < lastProcessedLedger) {
    console.warn(
      `tip_regression: reported tip ${latestLedger} is behind checkpoint lastProcessedLedger ${lastProcessedLedger}`
    )
    return { from: lastProcessedLedger + 1, to: lastProcessedLedger, status: 'skipped' as const, reason: 'tip-regression' }
  }

  // Normal case: process ledgers
  return { from: lastProcessedLedger + 1, to: latestLedger, status: 'processing' as const }
}
