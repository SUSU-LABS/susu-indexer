import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { computeLedgerRange, loadCheckpoint, saveCheckpoint } from '../../_shared/checkpoint.ts'
import { fetchLatestLedger } from '../../_shared/solana.ts'
import { processLedgerRange } from '../../_shared/processor.ts'
import { SUPABASE_URL, SERVICE_ROLE_KEY } from 'https://deno.land/x/dotenv@main/mod.ts'

const CHECKPOINT_PATH = '/tmp/checkpoint.json'
const START_LEDGER = parseInt(Deno.env.get('START_LEDGER') || '0')

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const network = req.url.split('?')[1]?.split('=')[1] ?? 'mainnet-beta'
  const latestLedger = await fetchLatestLedger(network)

  if (latestLedger === null) {
    return new Response(JSON.stringify({ error: 'Failed to fetch latest ledger' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const checkpoint = loadCheckpoint(CHECKPOINT_PATH)
  const range = computeLedgerRange(checkpoint, latestLedger, START_LEDGER)

  if (range === null) {
    return new Response(JSON.stringify({ status: 'skipped', reason: 'no-range' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Handle tip regression: do not process, return distinct status
  if (range.status === 'skipped' && range.reason === 'tip-regression') {
    return new Response(JSON.stringify({ status: 'tip-regression', tip: latestLedger, checkpoint: range.to }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (range.status === 'skipped' && range.reason === 'caught-up') {
    return new Response(JSON.stringify({ status: 'skipped', reason: 'caught-up', tip: latestLedger }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const results = await processLedgerRange(range.from, range.to, network)
  saveCheckpoint(CHECKPOINT_PATH, { lastProcessedLedger: range.to })

  return new Response(JSON.stringify({ status: 'processed', from: range.from, to: range.to, results }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})
