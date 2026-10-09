```ts
import { assertEquals, assertThrows } from "jsr:@std/assert";
import { withRetry, getDefaultIsRetryable } from "./retry.ts";

Deno.test("withRetry - retries on transient HTTP 5xx error", async () => {
  let callCount = 0;
  const error = new Error("Server error") as Error & { status: number };
  error.status = 500;

  const result = await withRetry(
    async () => {
      callCount++;
      if (callCount < 3) throw error;
      return "success";
    },
    { maxAttempts: 4, isRetryable: getDefaultIsRetryable() }
  );

  assertEquals(result, "success");
  assertEquals(callCount, 3);
});

Deno.test("withRetry - does not retry on 4xx validation RpcError", async () => {
  let callCount = 0;
  const error = new Error("Bad request") as Error & { status: number; code: number };
  error.status = 400;
  error.code = -32600;

  await assertThrows(
    async () => {
      await withRetry(
        async () => {
          callCount++;
          throw error;
        },
        { maxAttempts: 4, isRetryable: getDefaultIsRetryable() }
      );
    },
    Error,
    "Bad request"
  );

  assertEquals(callCount, 1);
});

Deno.test("withRetry - does not retry on Postgres constraint violation", async () => {
  let callCount = 0;
  const error = new Error("duplicate key") as Error & { code: string };
  error.code = "23505";

  await assertThrows(
    async () => {
      await withRetry(
        async () => {
          callCount++;
          throw error;
        },
        { maxAttempts: 4, isRetryable: getDefaultIsRetryable() }
      );
    },
    Error,
    "duplicate key"
  );

  assertEquals(callCount, 1);
});

Deno.test("withRetry - retries on network errors", async () => {
  let callCount = 0;
  const error = new Error("getaddrinfo ENOTFOUND") as Error & { code: string };
  error.code = "ENOTFOUND";

  const result = await withRetry(
    async () => {
      callCount++;
      if (callCount < 2) throw error;
      return "success";
    },
    { maxAttempts: 4, isRetryable: getDefaultIsRetryable() }
  );

  assertEquals(result, "success");
  assertEquals(callCount, 2);
});

Deno.test("withRetry - retries on HTTP 429", async () => {
  let callCount = 0;
  const error = new Error("Too Many Requests") as Error & { status: number };
  error.status = 429;

  const result = await withRetry(
    async () => {
      callCount++;
      if (callCount < 2) throw error;
      return "success";
    },
    { maxAttempts: 4, isRetryable: getDefaultIsRetryable() }
  );

  assertEquals(result, "success");
  assertEquals(callCount, 2);
});

Deno.test("withRetry - retries on HTTP 408", async () => {
  let callCount = 0;
  const error = new Error("Request Timeout") as Error & { status: number };
  error.status = 408;

  const result = await withRetry(
    async () => {
      callCount++;
      if (callCount < 2) throw error;
      return "success";
    },
    { maxAttempts: 4, isRetryable: getDefaultIsRetryable() }
  );

  assertEquals(result, "success");
  assertEquals(callCount, 2);
});

Deno.test("withRetry - does not retry on deterministic -32600 error", async () => {
  let callCount = 0;
  const error = new Error("startLedger must be within the ledger range") as Error & { code: number; status: number };
  error.code = -32600;
  error.status = 400;

  await assertThrows(
    async () => {
      await withRetry(
        async () => {
          callCount++;
          throw error;
        },
        { maxAttempts: 4, isRetryable: getDefaultIsRetryable() }
      );
    },
    Error,
    "startLedger must be within the ledger range"
  );

  assertEquals(callCount, 1);
});
