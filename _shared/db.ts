import * as db from './db';

export interface EventData {
  ledger_index: number;
  transaction_index: number;
  type: string;
  account?: string;
  destination?: string;
  send_max?: string;
  destination_tag?: number;
  invoice_id?: string;
  hash?: string;
  currency?: string;
  issuer?: string;
  amount?: string;
  quality?: string;
  limit_amount_currency?: string;
  limit_amount_issuer?: string;
  limit_amount_value?: string;
  [key: string]: unknown;
}

export interface PlanRow {
  ledger_index: number;
  transaction_index: number;
  type: string;
  signer?: string;
  multisign?: string;
  signer_list_id?: string;
  quality_in?: string;
  quality_out?: string;
  asset?: string;
  liability?: string;
  owner?: string;
  taker_gets_funded_currency?: string;
  taker_gets_funded_issuer?: string;
  taker_gets_funded_value?: string;
  taker_pays_funded_currency?: string;
  taker_pays_funded_issuer?: string;
  taker_pays_funded_value?: string;
  [key: string]: unknown;
}

export interface GroupRow {
  ledger_index: number;
  transaction_index: number;
  type: string;
  key: string;
  value: string;
  [key: string]: unknown;
}

const DEFAULT_BATCH_SIZE = 500;

export async function upsertEvents(
  events: EventData[],
  batchSize: number = DEFAULT_BATCH_SIZE
): Promise<void> {
  if (events.length === 0) return;

  for (let i = 0; i < events.length; i += batchSize) {
    const chunk = events.slice(i, i + batchSize);
    await db.upsertEvents(chunk);
  }
}

export async function persistPlan(
  plans: PlanRow[],
  batchSize: number = DEFAULT_BATCH_SIZE
): Promise<void> {
  if (plans.length === 0) return;

  for (let i = 0; i < plans.length; i += batchSize) {
    const chunk = plans.slice(i, i + batchSize);
    await db.persistPlan(chunk);
  }
}

export async function upsertGroups(
  groups: GroupRow[],
  batchSize: number = DEFAULT_BATCH_SIZE
): Promise<void> {
  if (groups.length === 0) return;

  for (let i = 0; i < groups.length; i += batchSize) {
    const chunk = groups.slice(i, i + batchSize);
    await db.upsertGroups(chunk);
  }
}

export { db };
