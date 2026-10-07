import { assertEquals, assertStringIncludes } from '@std/assert';
import { type SupabaseClient } from '@supabase/supabase-js';
import { IndexerDb } from '../supabase/functions/_shared/db.ts';
import {
  decodeChainEvents,
  type RejectedChainEvent,
} from '../supabase/functions/_shared/decode.ts';
import {
  handleRequest,
  type RpcSource,
  toRejectedEventRow,
} from '../supabase/functions/indexer/index.ts';
import type {
  EventPageStart,
  GetEventsResult,
  RpcEvent,
} from '../supabase/functions/_shared/stellar.ts';
import { FACTORY_ID, GROUP_ID, groupEvents, symbolTopic } from './fixture.ts';

type Row = Record<string, unknown>;

type StubCall = {
  table: string;
  op: 'select' | 'upsert' | 'insert' | 'update';
};

class StubSupabaseClient {
  readonly tables = new Map<string, Row[]>();
  readonly calls: StubCall[] = [];

  from(table: string): StubBuilder {
    return new StubBuilder(this, table);
  }

  rows(table: string): Row[] {
    let rows = this.tables.get(table);
    if (!rows) {
      rows = [];
      this.tables.set(table, rows);
    }
    return rows;
  }
}

class StubBuilder {
  #client: StubSupabaseClient;
  #table: string;
  #mode: StubCall['op'] | null = null;
  #maybeSingle = false;
  #upsertRows: Row[] = [];
  #insertRow: Row | null = null;

  constructor(client: StubSupabaseClient, table: string) {
    this.#client = client;
    this.#table = table;
  }

  select(_columns: string): this {
    this.#mode = 'select';
    return this;
  }

  order(_col: string, _opts?: { ascending: boolean }): this {
    return this;
  }

  range(_from: number, _to: number): this {
    return this;
  }

  eq(_column: string, _value: unknown): this {
    return this;
  }

  lt(_column: string, _value: unknown): this {
    return this;
  }

  maybeSingle(): this {
    this.#maybeSingle = true;
    return this;
  }

  upsert(
    rows: readonly Row[] | Row,
    _opts?: { onConflict?: string; ignoreDuplicates?: boolean },
  ): this {
    this.#mode = 'upsert';
    const list = Array.isArray(rows) ? rows : [rows];
    this.#upsertRows = list.map((r) => ({ ...r }));
    return this;
  }

  insert(row: Row): this {
    this.#mode = 'insert';
    this.#insertRow = { ...row };
    return this;
  }

  update(_values: Row): this {
    this.#mode = 'update';
    return this;
  }

  then(
    onfulfilled?: ((value: unknown) => unknown) | null,
    onrejected?: ((reason: unknown) => unknown) | null,
  ): Promise<unknown> {
    return this.#run().then(onfulfilled, onrejected);
  }

  #run(): Promise<unknown> {
    const tableRows = this.#client.rows(this.#table);
    if (this.#mode === 'upsert') {
      this.#client.calls.push({ table: this.#table, op: 'upsert' });
      for (const row of this.#upsertRows) {
        tableRows.push(row);
      }
      return Promise.resolve({ data: this.#upsertRows, error: null });
    }
    if (this.#mode === 'insert') {
      this.#client.calls.push({ table: this.#table, op: 'insert' });
      if (this.#insertRow) tableRows.push(this.#insertRow);
      return Promise.resolve({ data: this.#insertRow, error: null });
    }
    if (this.#mode === 'select') {
      if (this.#maybeSingle) {
        return Promise.resolve({ data: tableRows[0] ?? null, error: null });
      }
      return Promise.resolve({ data: tableRows, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  }
}

class ScriptedRpc implements RpcSource {
  #events: readonly RpcEvent[];
  #head: number;

  constructor(events: readonly RpcEvent[], head: number) {
    this.#events = events;
    this.#head = head;
  }

  getLatestLedger(): Promise<number> {
    return Promise.resolve(this.#head);
  }

  getEvents(
    start: EventPageStart,
    _cursor?: string,
    _filters?: readonly { type?: 'contract'; contractIds: readonly string[] }[],
    _limit?: number,
  ): Promise<GetEventsResult> {
    const from = 'startLedger' in start ? start.startLedger : 0;
    const inRange = this.#events.filter((e) => e.ledger >= from);
    return Promise.resolve({ events: [...inRange] });
  }
}

const TASK_SECRET = 'test-task-secret-0123456789abcdef';
const USDC_ID = `C${'B'.repeat(55)}`;
const SCENARIO_FROM = 4629055;
const SCENARIO_HEAD = 4629120;

function withTestEnv(): () => void {
  const vars: Record<string, string> = {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    INDEXER_TASK_SECRET: TASK_SECRET,
    STELLAR_RPC_URL: 'https://rpc.example.com',
    STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
    FACTORY_CONTRACT_ID: FACTORY_ID,
    USDC_CONTRACT_ID: USDC_ID,
    INDEXER_START_LEDGER: String(SCENARIO_FROM),
  };
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, Deno.env.get(key));
    Deno.env.set(key, value);
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  };
}

Deno.test('toRejectedEventRow preserves coordinates, reason, and identity', () => {
  const rejected: RejectedChainEvent = {
    eventId: '0000004629055-0000000001',
    reason: 'unknown event name: unexpected_v2_event',
    ledger: 4629055,
    txHash: 'hash123',
    txIndex: 1,
    eventIndex: 2,
    contractId: GROUP_ID,
  };

  const row = toRejectedEventRow(rejected);

  assertEquals(row.event_identity, '4629055-1-2-hash123');
  assertEquals(row.event_id, '0000004629055-0000000001');
  assertEquals(row.reason, 'unknown event name: unexpected_v2_event');
  assertEquals(row.ledger, 4629055);
  assertEquals(row.tx_hash, 'hash123');
  assertEquals(row.tx_index, 1);
  assertEquals(row.event_index, 2);
  assertEquals(row.contract_id, GROUP_ID);
});

Deno.test('decodeChainEvents preserves coordinates for rejected events in a batch', () => {
  const validEvent = groupEvents[0]!;
  const unrecognizedEvent: RpcEvent = {
    ...validEvent,
    id: 'rejected-event-id-999',
    topic: [symbolTopic('unrecognised_event'), symbolTopic('something')],
    ledger: 4629099,
    txHash: 'txhash_unrecognized',
    txIndex: 4,
    eventIndex: 7,
    contractId: GROUP_ID,
  };

  const { events, rejected } = decodeChainEvents([validEvent, unrecognizedEvent]);

  assertEquals(events.length, 1);
  assertEquals(rejected.length, 1);
  assertEquals(rejected[0]?.eventId, 'rejected-event-id-999');
  assertEquals(rejected[0]?.ledger, 4629099);
  assertEquals(rejected[0]?.txHash, 'txhash_unrecognized');
  assertEquals(rejected[0]?.contractId, GROUP_ID);
  assertStringIncludes(rejected[0]!.reason, 'unexpected event namespace');
});

Deno.test('handleRequest persists rejected events and records an alert when batch has an unrecognised event', async () => {
  const restoreEnv = withTestEnv();
  try {
    const validEvent = groupEvents[0]!;
    const rejectedEvent: RpcEvent = {
      ...validEvent,
      id: 'rejected-event-test-001',
      topic: [symbolTopic('unrecognised_v2_topic'), symbolTopic('extra_topic')],
      ledger: 4629060,
      txHash: 'hash_rejected_test',
      txIndex: 3,
      eventIndex: 5,
      contractId: FACTORY_ID,
      successful: true,
    };

    const stub = new StubSupabaseClient();
    const db = new IndexerDb(
      'https://example.supabase.co',
      'test-service-role-key',
      stub as unknown as SupabaseClient,
    );
    const rpc = new ScriptedRpc([validEvent, rejectedEvent], SCENARIO_HEAD);

    const request = new Request('http://localhost/', {
      headers: { 'x-indexer-task-secret': TASK_SECRET },
    });

    const response = await handleRequest(request, { db, rpc });
    assertEquals(response.status, 200);

    const body = await response.json();
    assertEquals(body.status, 'ok');
    assertEquals(body.eventsRejected, 1);

    // Verify durable record in rejected_events table
    const rejectedRows = stub.rows('rejected_events');
    assertEquals(rejectedRows.length, 1);
    assertEquals(rejectedRows[0]?.['event_id'], 'rejected-event-test-001');
    assertEquals(rejectedRows[0]?.['ledger'], 4629060);
    assertEquals(rejectedRows[0]?.['tx_hash'], 'hash_rejected_test');
    assertEquals(rejectedRows[0]?.['contract_id'], FACTORY_ID);
    assertStringIncludes(String(rejectedRows[0]?.['reason']), 'unexpected event namespace');

    // Verify open alert in indexer_alerts table
    const alertRows = stub.rows('indexer_alerts');
    assertEquals(alertRows.length, 1);
    assertEquals(alertRows[0]?.['kind'], 'rejected_events');
    assertEquals(alertRows[0]?.['subject'], 'decoder');
    const detail = alertRows[0]?.['detail'] as { count: number; reasons: string[] };
    assertEquals(detail.count, 1);
  } finally {
    restoreEnv();
  }
});
