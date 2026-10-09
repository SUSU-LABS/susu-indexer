import { assertEquals } from '@std/assert';
import { type SupabaseClient } from '@supabase/supabase-js';
import { TASK_SECRET_HEADER } from '../supabase/functions/_shared/auth.ts';
import { IndexerDb } from '../supabase/functions/_shared/db.ts';
import { handleRequest } from '../supabase/functions/indexer/index.ts';

const TASK_SECRET = 'a'.repeat(48);

function setupEnv(): void {
  Deno.env.set('SUPABASE_URL', 'https://example.supabase.co');
  Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key');
  Deno.env.set('INDEXER_TASK_SECRET', TASK_SECRET);
  Deno.env.set('STELLAR_RPC_URL', 'https://soroban-testnet.stellar.org');
  Deno.env.set('STELLAR_NETWORK_PASSPHRASE', 'Test SDF Network ; September 2015');
  Deno.env.set('FACTORY_CONTRACT_ID', `C${'A'.repeat(55)}`);
  Deno.env.set('USDC_CONTRACT_ID', `C${'B'.repeat(55)}`);
  Deno.env.set('STELLAR_NETWORK', 'testnet');
}

Deno.test('recordRunFailure never rejects when insert throws/rejects', async () => {
  const stubClient = {
    from(_table: string) {
      return {
        insert(_row: unknown) {
          return Promise.reject(new Error('simulated network transport failure'));
        },
      };
    },
  } as unknown as SupabaseClient;

  const db = new IndexerDb('https://example.supabase.co', 'dummy-key', stubClient);

  // Must resolve cleanly without throwing
  await db.recordRunFailure({
    correlationId: 'test-correlation-id',
    ledgerFrom: 100,
    ledgerTo: 200,
    reason: 'simulated failure',
  });
});

Deno.test('recordRunFailure never rejects when insert returns an error', async () => {
  const stubClient = {
    from(_table: string) {
      return {
        insert(_row: unknown) {
          return Promise.resolve({ error: { message: 'relation does not exist' } });
        },
      };
    },
  } as unknown as SupabaseClient;

  const db = new IndexerDb('https://example.supabase.co', 'dummy-key', stubClient);

  // Must resolve cleanly without throwing
  await db.recordRunFailure({
    correlationId: 'test-correlation-id',
    ledgerFrom: 100,
    ledgerTo: 200,
    reason: 'simulated failure',
  });
});

Deno.test('handleRequest returns structured 500 when insert rejects during failure recording', async () => {
  setupEnv();

  const stubClient = {
    from(table: string) {
      if (table === 'indexer_checkpoints') {
        return {
          select(_cols: string) {
            return {
              eq(_col: string, _val: string) {
                return {
                  maybeSingle() {
                    return Promise.reject(new Error('database unavailable'));
                  },
                };
              },
            };
          },
        };
      }
      if (table === 'indexer_runs') {
        return {
          insert(_row: unknown) {
            return Promise.reject(new Error('network down during failure insert'));
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient;

  const db = new IndexerDb('https://example.supabase.co', 'dummy-key', stubClient);

  const request = new Request('https://example.supabase.co/functions/v1/indexer', {
    method: 'POST',
    headers: {
      [TASK_SECRET_HEADER]: TASK_SECRET,
    },
  });

  const response = await handleRequest(request, { db });
  assertEquals(response.status, 500);

  const body = await response.json();
  assertEquals(body.status, 'failed');
  assertEquals(typeof body.correlationId, 'string');
  assertEquals(body.reason, 'database unavailable');
});

Deno.test('handleRequest returns structured 500 even if recordRunFailure itself rejects', async () => {
  setupEnv();

  const brokenDb = {
    getCheckpoint() {
      return Promise.reject(new Error('rpc error'));
    },
    recordRunFailure() {
      return Promise.reject(new Error('catastrophic failure'));
    },
  } as unknown as IndexerDb;

  const request = new Request('https://example.supabase.co/functions/v1/indexer', {
    method: 'POST',
    headers: {
      [TASK_SECRET_HEADER]: TASK_SECRET,
    },
  });

  const response = await handleRequest(request, { db: brokenDb });
  assertEquals(response.status, 500);

  const body = await response.json();
  assertEquals(body.status, 'failed');
  assertEquals(typeof body.correlationId, 'string');
  assertEquals(body.reason, 'rpc error');
});
