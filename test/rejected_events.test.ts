import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Database } from "../deps.ts";
import { index, checkIndexerHealth } from "../src/index.ts";
import { createTestDb, closeTestDb } from "../test_helpers.ts";
import { IndexerConfig } from "../src/interfaces.ts";

function createMockProvider(rejectedBlockNumber = 1001) {
  return async (blockNumber: number) => {
    if (blockNumber === rejectedBlockNumber) {
      return {
        number: blockNumber,
        hash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
        parentHash: `0x${(blockNumber - 1).toString(16).padStart(64, "0")}`,
        timestamp: Math.floor(Date.now() / 1000),
        logs: [
          {
            address: "0x1111111111111111111111111111111111111111",
            data: "0xdeadbeef",
            topics: ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
            blockNumber,
            transactionHash: `0xtx${blockNumber}`,
            logIndex: 0,
            transaction: { data: "0xdeadbeef" },
          },
        ],
      };
    }
    return {
      number: blockNumber,
      hash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
      parentHash: `0x${(blockNumber - 1).toString(16).padStart(64, "0")}`,
      timestamp: Math.floor(Date.now() / 1000),
      logs: [],
    };
  };
}

const baseConfig: IndexerConfig = {
  chainName: "Base",
  rpcUrl: "https://example.com",
  startBlock: 1000,
  batchSize: 10,
  pollingInterval: 50,
  contractAddresses: ["0x1111111111111111111111111111111111111111"],
  contractNames: ["TestContract"],
  includeEventData: false,
  alertThreshold: 1000,
};

describe("rejected events persistence and alerting", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    closeTestDb(db);
  });

  it("persists rejected events to the rejected_events table", async () => {
    const provider = createMockProvider(1001);
    // Run indexer long enough to process block 1001 then stop
    const abort = new AbortController();
    const indexPromise = index(baseConfig, db, provider);
    await new Promise((resolve) => setTimeout(resolve, 300));
    abort.abort();
    try { await indexPromise; } catch {}

    const rows = db
      .selectFrom("rejected_events")
      .selectAll()
      .executeSync();

    assert.ok(rows.length > 0, "Expected rejected events to be persisted");
    const rejected = rows[0] as Record<string, unknown>;
    assert.equal(rejected.block_number, 1001);
    assert.equal(rejected.contract_address, "0x1111111111111111111111111111111111111111");
    assert.ok(rejected.decoder_error);
  });

  it("surfaces rejected event count in indexer health alerts", async () => {
    const provider = createMockProvider(1001);
    const abort = new AbortController();
    const indexPromise = index(baseConfig, db, provider);
    await new Promise((resolve) => setTimeout(resolve, 300));
    abort.abort();
    try { await indexPromise; } catch {}

    const health = await checkIndexerHealth(baseConfig, db, provider);

    const rejectAlert = health.alerts.find(
      (a) => a.context.rejectedCount !== undefined,
    );
    assert.ok(rejectAlert, "Expected a reject-related alert");
    assert.equal(rejectAlert.level, "warning");
    assert.ok(String(rejectAlert.message).includes("rejected"));
  });
});
