import { assertEquals, assertStringIncludes } from '@std/assert';
import { TASK_SECRET_HEADER } from '../supabase/functions/_shared/auth.ts';
import { handleRequest } from '../supabase/functions/indexer/index.ts';

const TASK_SECRET = 'config-diagnostics-test-secret-0000000000';
const invalidEnv = { INDEXER_TASK_SECRET: TASK_SECRET };
const CONFIG_VARIABLES = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'INDEXER_TASK_SECRET',
  'STELLAR_RPC_URL',
  'STELLAR_NETWORK_PASSPHRASE',
  'FACTORY_CONTRACT_ID',
  'USDC_CONTRACT_ID',
];

Deno.test('unauthenticated configuration failures do not expose variable names', async () => {
  const response = await handleRequest(new Request('http://localhost/indexer'), {
    env: invalidEnv,
  });
  const body = await response.text();

  assertEquals(response.status, 401);
  assertEquals(JSON.parse(body).reason, 'unauthorized');
  for (const variable of CONFIG_VARIABLES) {
    assertEquals(body.includes(variable), false);
  }
});

Deno.test('authorized configuration failures retain actionable diagnostics', async () => {
  const request = new Request('http://localhost/indexer', {
    headers: { [TASK_SECRET_HEADER]: TASK_SECRET },
  });
  const response = await handleRequest(request, { env: invalidEnv });
  const body = await response.text();

  assertEquals(response.status, 500);
  assertStringIncludes(JSON.parse(body).reason, 'SUPABASE_URL');
  assertStringIncludes(JSON.parse(body).reason, 'SUPABASE_SERVICE_ROLE_KEY');
  assertStringIncludes(JSON.parse(body).reason, 'FACTORY_CONTRACT_ID');
});
