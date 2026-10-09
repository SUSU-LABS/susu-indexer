/**
 * URL and error-message sanitization.
 *
 * Hosted Soroban RPC URLs commonly embed an API key or token — in the query
 * string (`?api-key=...`) or in userinfo (`https://key@host/...`). On a
 * network failure Deno's `fetch` throws a `TypeError` whose message includes
 * the full request URL, so the credential would flow verbatim into logs, the
 * HTTP response body and `indexer_runs.reason`. These helpers strip the
 * secret-carrying parts while keeping the host and path, so an operator can
 * still tell *which* endpoint failed without the credential traveling with it.
 */

/**
 * Strips the secret-carrying parts of a URL: the query string and any
 * userinfo. The scheme, host and path are kept for debuggability.
 *
 * Unparseable input is not passed through — a best-effort parse that fails
 * means we cannot tell where the secret ends, so the whole value is dropped.
 */
export function sanitizeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '[unparseable-url]';
  }
  parsed.search = '';
  parsed.username = '';
  parsed.password = '';
  return parsed.toString();
}

/** Matches absolute http(s) URLs inside a larger message. */
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/g;

/**
 * Trailing punctuation that ends a sentence or a parenthetical, not a URL.
 * `fetch` failure messages look like `request for url (https://h/p?k=v):
 * refused` — without this, the `)` and `:` get swallowed into the match and
 * the message comes out mangled.
 */
const TRAILING_PUNCT = /[.,;:!?)\]}]+$/;

/**
 * Replaces every absolute http(s) URL in `msg` with its sanitized form.
 *
 * Messages without URLs pass through unchanged, so ordinary error text is
 * never altered. Trailing punctuation is preserved verbatim.
 */
export function sanitizeErrorMessage(msg: string): string {
  return msg.replace(URL_PATTERN, (url) => {
    const trail = url.match(TRAILING_PUNCT)?.[0] ?? '';
    const core = trail ? url.slice(0, -trail.length) : url;
    return sanitizeUrl(core) + trail;
  });
}
