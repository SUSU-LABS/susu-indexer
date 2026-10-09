```ts
import { getBlock, getLogs } from "@sushiswap/sushi-sdk";
import { createClient } from "supabase/libs";
import { withRetry, getDefaultIsRetryable } from "../_shared/retry.ts";
import { upsertEvents, persistPlan } from "../_shared/db.ts";

const MAX_RETRIES = 4;

interface IndexerParams {
  ledgerId: string;
  fromLedger?: number;
  toLedger?: number;
}

async function indexLedger(params: IndexerParams) {
  const { ledgerId, fromLedger, toLedger } = params;

  console.log(`Indexing ledger ${ledgerId} from ${fromLedger} to ${toLedger}`);

  // Fetch block range
  let currentLedger = fromLedger;
  const endLedger = toLedger ?? currentLedger + 100;

  while (currentLedger && currentLedger <= endLedger) {
    try {
      // Fetch block with retry
      const block = await withRetry(
        async () => {
          const response = await getBlock(currentLedger);
          return response.block;
        },
        {
          maxAttempts: MAX_RETRIES,
          isRetryable: getDefaultIsRetryable(),
        }
      );

      if (!block) {
        console.log(`Block ${currentLedger} not found, skipping`);
        currentLedger++;
        continue;
      }

      // Fetch logs with retry
      const logs = await withRetry(
        async () => {
          const response = await getLogs({ blockNumber: currentLedger });
          return response.logs || [];
        },
        {
          maxAttempts: MAX_RETRIES,
          isRetryable: getDefaultIsRetryable(),
        }
      );

      // Upsert events
      if (logs.length > 0) {
        await withRetry(
          async () => upsertEvents(logs),
          {
            maxAttempts: MAX_RETRIES,
            isRetryable: getDefaultIsRetryable(),
          }
        );
      }

      // Persist plan
      await withRetry(
        async () => persistPlan(ledgerId, currentLedger),
        {
          maxAttempts: MAX_RETRIES,
          isRetryable: getDefaultIsRetryable(),
        }
      );

      currentLedger++;
    } catch (error) {
      console.error(`Failed to index ledger ${currentLedger}:`, error);
      throw error;
    }
  }

  console.log(`Completed indexing ledger ${ledgerId}`);
}

export async function handler(request: Request) {
  const { searchParams } = new URL(request.url);
  const ledgerId = searchParams.get("ledgerId");
  const fromLedger = searchParams.get("fromLedger")
    ? parseInt(searchParams.get("fromLedger")!)
    : undefined;
  const toLedger = searchParams.get("toLedger")
    ? parseInt(searchParams.get("toLedger")!)
    : undefined;

  if (!ledgerId) {
    return new Response(
      JSON.stringify({ error: "ledgerId is required" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  try {
    await indexLedger({ ledgerId, fromLedger, toLedger });

    return new Response(
      JSON.stringify({
        success: true,
        ledgerId,
      }),
      {
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Indexing failed:", error);
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
