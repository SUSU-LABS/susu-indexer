import { serve } from 'https://deno.land/std@0.177.4/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getXdrDecodedJson } from 'https://deno.land/x/suco@0.1.0/mod.ts';
import { toIndexedRow, batchUpsert, getCheckpoint } from '../../_shared/db.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

const INDEXER_MAX_LEDGER_RANGE = parseInt(Deno.env.get('INDEXER_MAX_LEDGER_RANGE') || '1000');
const BATCH_SIZE = parseInt(Deno.env.get('BATCH_SIZE') || '500');

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const body = await req.json() as { startLedger: number; endLedger: number };
  const { startLedger, endLedger } = body;

  try {
    const checkpoint = await getCheckpoint(supabase);
    const start = Math.max(startLedger, checkpoint?.ledger_index ?? startLedger - 1);

    const ledgerEntries = await fetchLedgerEntries(start, endLedger);
    const rawEvents: unknown[] = [];
    const rawPlans: unknown[] = [];
    const rawGroups: unknown[] = [];

    for (const entry of ledgerEntries) {
      const decoded = getXdrDecodedJson(entry.xdr);
      extractEvents(decoded, rawEvents, rawPlans, rawGroups, entry);
    }

    // Batch writes instead of single unbounded upsert
    const rows = rawEvents.map(toIndexedRow);
    await batchUpsert(supabase, 'events', rows, BATCH_SIZE);

    await batchUpsert(supabase, 'plans', rawPlans.map((p) => p), BATCH_SIZE);
    await batchUpsert(supabase, 'groups', rawGroups.map((g) => g), BATCH_SIZE);

    await supabase
      .from('checkpoints')
      .upsert({ ledger_index: endLedger, updated_at: new Date().toISOString() });

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err) {
    console.error('Indexer error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
});

async function fetchLedgerEntries(start: number, end: number) {
  const entries = [];
  for (let i = start; i <= end; i++) {
    const resp = await fetch(`https://selenium.stellar-sandbox.org/ledgers/${i}`);
    const data = await resp.json() as { xdr: string };
    entries.push(data);
  }
  return entries;
}

function extractEvents(
  decoded: unknown,
  events: unknown[],
  plans: unknown[],
  groups: unknown[],
  entry: { ledger_index: number; transaction_index: number }
) {
  // Simplified extraction — real impl would walk XDR tree
  if (Array.isArray(decoded)) {
    for (const item of decoded) {
      if (item && typeof item === 'object' && 'type' in item) {
        const t = (item as Record<string, unknown>).type as string;
        if (t?.startsWith('transaction')) {
          plans.push({ ...item, ledger_index: entry.ledger_index, transaction_index: entry.transaction_index });
        } else if (t?.startsWith('event')) {
          events.push({ ...item, ledger_index: entry.ledger_index, transaction_index: entry.transaction_index });
        } else if (t?.startsWith('group')) {
          groups.push({ ...item, ledger_index: entry.ledger_index, transaction_index: entry.transaction_index });
        }
      }
    }
  }
}
