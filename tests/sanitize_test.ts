/**
 * URL and error-message sanitization tests.
 *
 * The threat: a hosted Soroban RPC URL embeds an API key or token. On a
 * network failure Deno's `fetch` throws a `TypeError` whose message includes
 * the full request URL, and that message flows into logs, the HTTP response
 * and `indexer_runs.reason`. These tests pin the guarantee that the
 * credential never survives that journey.
 */

import { assertEquals, assertNotMatch, assertStringIncludes } from '@std/assert';
import { sanitizeErrorMessage, sanitizeUrl } from '../supabase/functions/_shared/sanitize.ts';
import { SorobanRpcClient } from '../supabase/functions/_shared/stellar.ts';

const TOKEN = 'sk-test-token-abc123';
const TOKENIZED_URL = `https://soroban-testnet.stellar.org:443/api?api-key=${TOKEN}`;
const USERINFO_URL = `https://${TOKEN}@soroban-testnet.stellar.org/api`;

Deno.test('sanitizeUrl strips the query string but keeps host and path', () => {
  const result = sanitizeUrl(TOKENIZED_URL);
  assertEquals(result.includes(TOKEN), false);
  assertStringIncludes(result, 'soroban-testnet.stellar.org');
  assertStringIncludes(result, '/api');
});

Deno.test('sanitizeUrl strips userinfo credentials', () => {
  const result = sanitizeUrl(USERINFO_URL);
  assertEquals(result.includes(TOKEN), false);
  assertStringIncludes(result, 'soroban-testnet.stellar.org');
});

Deno.test('sanitizeUrl leaves a clean URL untouched', () => {
  assertEquals(
    sanitizeUrl('https://soroban-testnet.stellar.org/api'),
    'https://soroban-testnet.stellar.org/api',
  );
});

Deno.test('sanitizeUrl drops unparseable input instead of passing it through', () => {
  assertEquals(sanitizeUrl('not a url at all'), '[unparseable-url]');
});

Deno.test('sanitizeErrorMessage removes a tokenized URL from a fetch-style message', () => {
  const msg = `error sending request for url (${TOKENIZED_URL}): connection refused`;
  const result = sanitizeErrorMessage(msg);
  assertEquals(result.includes(TOKEN), false);
  // The operator can still tell which endpoint failed.
  assertStringIncludes(result, 'soroban-testnet.stellar.org');
  assertStringIncludes(result, 'connection refused');
});

Deno.test('sanitizeErrorMessage preserves trailing punctuation around the URL', () => {
  const msg = `error sending request for url (${TOKENIZED_URL}): connection refused.`;
  const result = sanitizeErrorMessage(msg);
  assertEquals(result.includes(TOKEN), false);
  // The paren and colon are message text, not part of the URL.
  assertStringIncludes(result, '): connection refused.');
});

Deno.test('sanitizeErrorMessage leaves ordinary messages unchanged', () => {
  const msg = 'RPC request failed with status 503';
  assertEquals(sanitizeErrorMessage(msg), msg);
});

/** Runs `body` with `fetch` replaced by one that throws like Deno does on a network failure. */
async function withFailingFetch(url: string, body: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = ((_url: string | URL | Request) => {
    // Deno's real TypeError embeds the request URL verbatim.
    return Promise.reject(
      new TypeError(`error sending request for url (${url}): connection reset`),
    );
  }) as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test('SorobanRpcClient fetch failure never surfaces the embedded token', async () => {
  const client = new SorobanRpcClient(TOKENIZED_URL);
  let caught: unknown;
  await withFailingFetch(TOKENIZED_URL, async () => {
    try {
      await client.getLatestLedger();
    } catch (error) {
      caught = error;
    }
  });
  const message = (caught as Error).message;
  // Nondescript failure text: printing `message` here would itself leak the
  // token into test output on failure.
  assertEquals(message.includes(TOKEN), false, 'token leaked into RpcError message');
  assertNotMatch(message, /api-key=/);
});
