import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { Database } from "./types/database.types";
import { runSubqueries } from "./queries/subqueries";
import { runAlerts } from "./queries/alerts";
import { fetchLatestFinalizedLedger } from "./api/fetchLatestFinalizedLedger";
import { runMigrations } from "./migrations/runMigrations";
import { createLogger } from "./utils/logger";
import { sleep } from "./utils/sleep";

const logger = createLogger("indexer");
const { DATABASE_URL, SUPABASE_ANON_KEY, INDEXER_INTERVAL_MS, LEDGER_BUFFER_SIZE } = process.env;

if (!DATABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Missing required environment variables");
}

const supabase = createClient<Database>(DATABASE_URL, SUPABASE_ANON_KEY);

const ConfigSchema = z.object({
  batchSize: z.number(),
  buffer: z.number(),
});

export type Config = z.infer<typeof ConfigSchema>;

async function getRunConfig(): Promise<Config> {
  const { data, error } = await supabase
    .from("run_configs")
    .select("*")
    .single();

  if (error) throw error;
  if (!data) throw new Error("No run config found");

  return ConfigSchema.parse(data);
}

async function recordRunStart() {
  const { error } = await supabase
    .from("indexer_runs")
    .insert({ ledger_from: 0, ledger_to: 0, status: "running" });
  if (error) {
    logger.error("Failed to record run start", error);
    throw error;
  }
}

async function recordRunSuccess(ledgerFrom: number, ledgerTo: number) {
  const { error } = await supabase
    .from("indexer_runs")
    .update({
      ledger_from: ledgerFrom,
      ledger_to: ledgerTo,
      status: "completed",
      completed_at: new Date().toISOString(),
    })
    .eq("id", (await supabase.from("indexer_runs").select("id").order("created_at", { ascending: false }).single()).data?.id);

  if (error) {
    logger.error("Failed to record run success", error);
  }
}

async function recordRunFailure(ledgerFrom: number, ledgerTo: number, error: unknown) {
  const runId = (await supabase.from("indexer_runs").select("id").order("created_at", { ascending: false }).single()).data?.id;

  const { error: updateError } = await supabase
    .from("indexer_runs")
    .update({
      ledger_from: ledgerFrom,
      ledger_to: ledgerTo,
      status: "failed",
      completed_at: new Date().toISOString(),
      error_message: error instanceof Error ? error.message : String(error),
    })
    .eq("id", runId);

  if (updateError) {
    logger.error("Failed to record run failure", updateError);
  }
}

async function main() {
  const config = await getRunConfig();
  const intervalMs = parseInt(INDEXER_INTERVAL_MS || "60000");
  const ledgerBufferSize = parseInt(LEDGER_BUFFER_SIZE || "10");

  while (true) {
    let rangeFrom: number | undefined;
    let rangeTo: number | undefined;

    try {
      const latestLedger = await fetchLatestFinalizedLedger();
      const { data: lastRun } = await supabase
        .from("indexer_runs")
        .select("ledger_to")
        .order("created_at", { ascending: false })
        .single();

      rangeFrom = (lastRun?.ledger_to ?? 0) + 1;
      rangeTo = Math.min(latestLedger, rangeFrom + config.batchSize - 1);

      // Only proceed if there's a meaningful range to process
      if (rangeFrom > rangeTo) {
        logger.debug(`No new ledgers to process (rangeFrom=${rangeFrom}, rangeTo=${rangeTo}, latest=${latestLedger})`);
        await recordRunSuccess(rangeFrom, rangeTo);
        await sleep(intervalMs);
        continue;
      }

      await recordRunStart();

      await runSubqueries(rangeFrom, rangeTo);
      await runAlerts(rangeFrom, rangeTo);

      await recordRunSuccess(rangeFrom, rangeTo);
      logger.info(`Completed processing ledgers ${rangeFrom}-${rangeTo}`);

    } catch (error) {
      logger.error("Indexer run failed", error);
      // Use the computed range if available, otherwise fall back to 0
      const failFrom = rangeFrom ?? 0;
      const failTo = rangeTo ?? 0;
      await recordRunFailure(failFrom, failTo, error);
      await sleep(intervalMs);
    }
  }
}

// Run migrations on startup
runMigrations().catch(console.error);

// Start the indexer
main().catch((error) => {
  logger.error("Fatal indexer error", error);
  process.exit(1);
});
