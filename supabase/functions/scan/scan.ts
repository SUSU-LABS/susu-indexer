```ts
import { XRPCError } from "@sinclair/xrpc";
import { getAccount, getBalance, getBlocks } from "@sushiswap/sushi-sdk";
import { createClient } from "supabase/libs";
import { withRetry, getDefaultIsRetryable } from "../_shared/retry.ts";
import { upsertAccountBalances } from "../_shared/db.ts";
import type { Account } from "../_shared/db.ts";

const MAX_RETRIES = 4;

interface ScanParams {
  cursor?: string;
  limit?: number;
}

async function fetchAndProcessBlocks(params: ScanParams) {
  const cursor = params.cursor ?? null;
  const limit = params.limit ?? 10;

  const blocks = await withRetry(
    async () => {
      const response = await getBlocks({ cursor, limit });
      return response.blocks || [];
    },
    {
      maxAttempts: MAX_RETRIES,
      isRetryable: getDefaultIsRetryable(),
    }
  );

  if (blocks.length === 0) {
    console.log("No blocks to process");
    return null;
  }

  // Process each block
  for (const block of blocks) {
    try {
      // Fetch account data for this block
      for (const tx of block.transactions || []) {
        try {
          const account = await withRetry(
            async () => getAccount(tx.account),
            {
              maxAttempts: MAX_RETRIES,
              isRetryable: getDefaultIsRetryable(),
            }
          );

          if (account) {
            await upsertAccountBalances([account] as Account[]);
          }
        } catch (error) {
          console.error(`Failed to process account ${tx.account}:`, error);
        }
      }
    } catch (error) {
      console.error(`Failed to process block ${block.blockNumber}:`, error);
    }
  }

  return blocks[blocks.length - 1]?.blockNumber ?? null;
}

export async function handler(request: Request) {
  const { searchParams } = new URL(request.url);
  const cursor = searchParams.get("cursor") || undefined;
  const limit = parseInt(searchParams.get("limit") || "10");

  try {
    const newCursor = await fetchAndProcessBlocks({ cursor, limit });

    return new Response(
      JSON.stringify({
        success: true,
        cursor: newCursor,
      }),
      {
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Scan failed:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
