import {
  getCheckpoints,
  deleteCheckpoints,
} from '../ledger_checkpoints/record'
import { getContract } from '../stellar/horizon'
import {
  INDEXER_START_LEDGER,
  INDEXER_CHECKPOINT_STORAGE_KEY,
  INDEXER_START_FROM,
} from '../utils/constants'

interface CheckpointRecord {
  ledger: number
  hash: string
  type: 'sequence' | 'full'
}

export async function computeLedgerRange(): Promise<{
  from: number
  to: number
  isInitialized: boolean
}> {
  const contract = await getContract()
  const sequence = await contract.latest.sequence()
  const checkpoints = await getCheckpoints()

  const startLedger = parseInt(
    process.env[INDEXER_START_LEDGER] ??
      (await contract.contractSource.readData(INDEXER_START_FROM)),
    10
  )

  if (checkpoints.length === 0) {
    return {
      from: startLedger,
      to: sequence,
      isInitialized: false,
    }
  }

  const sorted = [...checkpoints].sort((a, b) => a.ledger - b.ledger)
  const lastProcessedLedger = sorted[sorted.length - 1].ledger
  const fullCheckpointLedger =
    checkpoints.find((c) => c.type === 'full')?.ledger ?? startLedger

  // When a checkpoint exists and startLedger was raised above the checkpoint,
  // do NOT silently skip ledgers. Log a warning and ignore the raised value.
  if (startLedger > lastProcessedLedger + 1) {
    console.warn(
      `[checkpoint] INDEXER_START_LEDGER (${startLedger}) is greater than the last processed ledger (${lastProcessedLedger}) + 1. ` +
        `Silent skip would leave a permanent gap of ${startLedger - lastProcessedLedger - 1} ledger(s). ` +
        `Ignoring raised startLedger; resuming from ${lastProcessedLedger + 1}. ` +
        `To perform a rebuild, delete checkpoints first via \`supabase functions call ledger_checkpoints/delete\`.`
    )
  }

  const from = Math.min(startLedger, lastProcessedLedger + 1)

  return {
    from,
    to: sequence,
    isInitialized: true,
  }
}

export async function getCheckpoint(ledger: number): Promise<CheckpointRecord | null> {
  const checkpoints = await getCheckpoints()
  return checkpoints.find((c) => c.ledger === ledger) ?? null
}

export async function saveCheckpoint(checkpoint: CheckpointRecord): Promise<void> {
  const checkpoints = await getCheckpoints()
  const existing = checkpoints.find((c) => c.ledger === checkpoint.ledger)
  if (existing) {
    existing.type = checkpoint.type
  } else {
    checkpoints.push(checkpoint)
  }
  await deleteCheckpoints()
  for (const cp of checkpoints) {
    await getContract().recordCheckpoint(cp.ledger, cp.hash, cp.type)
  }
}
