import { assertEquals, assertStringIncludes } from '@std/assert';
import { handleRequest } from '../supabase/functions/indexer/index.ts';
import { TASK_SECRET_HEADER } from '../supabase/functions/_shared/auth.ts';
import type { IndexerConfig } from '../supabase/functions/_shared/config.ts';

const TEST_SECRET = 'a'.repeat(48);

function createRequest(secret?: string): Request {
  const headers = new Headers();
  if (secret !== undefined) {
    headers.set(TASK_SECRET_HEADER, secret);
  }
  return new Request('https://indexer.example.com/', {
    method: 'POST',
    headers,
  });
}

Deno.test('unauthenticated request never receives variable names when config is missing', async () => {
  // Clear any existing env variables that might configure the indexer
  const previousEnv = Deno.env.get('INDEXER_TASK_SECRET');
  try {
    Deno.env.set('INDEXER_TASK_SECRET', TEST_SECRET);

    const req = createRequest(undefined); // No secret header
    const response = await handleRequest(req);

    assertEquals(response.status, 401);
    const body = await response.json();
    assertEquals(body.status, 'failed');
    assertEquals(body.reason, 'unauthorized');

    // Crucial check: Variable names must not leak
    const bodyText = JSON.stringify(body);
    assertEquals(bodyText.includes('SUPABASE_URL'), false);
    assertEquals(bodyText.includes('missing'), false);
    assertEquals(bodyText.includes('invalid configuration'), false);
  } finally {
    if (previousEnv !== undefined) {
      Deno.env.set('INDEXER_TASK_SECRET', previousEnv);
    } else {
      Deno.env.delete('INDEXER_TASK_SECRET');
    }
  }
});

Deno.test('unauthenticated request with wrong secret never receives config error details', async () => {
  const previousEnv = Deno.env.get('INDEXER_TASK_SECRET');
  try {
    Deno.env.set('INDEXER_TASK_SECRET', TEST_SECRET);

    const req = createRequest('wrong_secret');
    const response = await handleRequest(req);

    assertEquals(response.status, 401);
    const body = await response.json();
    assertEquals(body.status, 'failed');
    assertEquals(body.reason, 'unauthorized');

    const bodyText = JSON.stringify(body);
    assertEquals(bodyText.includes('SUPABASE_URL'), false);
    assertEquals(bodyText.includes('missing'), false);
  } finally {
    if (previousEnv !== undefined) {
      Deno.env.set('INDEXER_TASK_SECRET', previousEnv);
    } else {
      Deno.env.delete('INDEXER_TASK_SECRET');
    }
  }
});

Deno.test('authorized request still gets actionable config diagnostics on missing variables', async () => {
  const previousEnv = Deno.env.get('INDEXER_TASK_SECRET');
  const previousUrl = Deno.env.get('SUPABASE_URL');
  try {
    Deno.env.set('INDEXER_TASK_SECRET', TEST_SECRET);
    Deno.env.delete('SUPABASE_URL'); // Ensure incomplete config

    const req = createRequest(TEST_SECRET);
    const response = await handleRequest(req);

    assertEquals(response.status, 500);
    const body = await response.json();
    assertEquals(body.status, 'failed');
    assertStringIncludes(body.reason, 'invalid configuration');
    assertStringIncludes(body.reason, 'SUPABASE_URL');
  } finally {
    if (previousEnv !== undefined) {
      Deno.env.set('INDEXER_TASK_SECRET', previousEnv);
    } else {
      Deno.env.delete('INDEXER_TASK_SECRET');
    }
    if (previousUrl !== undefined) {
      Deno.env.set('SUPABASE_URL', previousUrl);
    }
  }
});

Deno.test('unauthenticated request fails without leak even when INDEXER_TASK_SECRET is unset', async () => {
  const previousEnv = Deno.env.get('INDEXER_TASK_SECRET');
  try {
    Deno.env.delete('INDEXER_TASK_SECRET');

    const req = createRequest(undefined);
    const response = await handleRequest(req);

    assertEquals(response.status, 401);
    const body = await response.json();
    assertEquals(body.status, 'failed');
    assertEquals(body.reason, 'unauthorized');

    const bodyText = JSON.stringify(body);
    assertEquals(bodyText.includes('INDEXER_TASK_SECRET'), false);
    assertEquals(bodyText.includes('missing'), false);
  } finally {
    if (previousEnv !== undefined) {
      Deno.env.set('INDEXER_TASK_SECRET', previousEnv);
    }
  }
});
