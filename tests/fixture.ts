/**
 * Decoder fixtures in the shape the RPC client produces.
 *
 * Shared by decoder and ingest tests. The config-event additions are explicitly
 * synthetic; their shape has not yet been confirmed against a Testnet capture.
 */

import { xdr } from '@stellar/stellar-sdk';
import { decodeChainEvent, type DecodedChainEvent } from '../supabase/functions/_shared/decode.ts';
import type { RpcEvent } from '../supabase/functions/_shared/stellar.ts';
import fixture from './fixtures/chain_events.json' with { type: 'json' };

/** A raw sample, as it appears in the fixture. */
export type RawEvent = {
  ledger: number;
  txHash: string;
  transactionIndex: number;
  contractId: string;
  id: string;
  topic: string[];
  value: string;
  inSuccessfulContractCall: boolean;
};

export const FACTORY_ID = fixture.factory_contract_id;
export const GROUP_ID = fixture.group_contract_id;

/** Encodes a symbol topic the way the contracts do, rather than by hand. */
export function symbolTopic(value: string): string {
  return xdr.ScVal.scvSymbol(value).toXDR('base64');
}

/** Converts a captured event into the shape the RPC client produces. */
export function toRpcEvent(raw: RawEvent): RpcEvent {
  const ordinal = Number.parseInt(raw.id.slice(raw.id.lastIndexOf('-') + 1), 10);
  return {
    ledger: raw.ledger,
    txHash: raw.txHash,
    txIndex: raw.transactionIndex,
    eventIndex: ordinal,
    id: raw.id,
    contractId: raw.contractId,
    topic: raw.topic,
    value: raw.value,
    successful: raw.inSuccessfulContractCall,
  };
}

const rawFactoryEvents = fixture.factory_events as RawEvent[];
const rawGroupEvents = fixture.group_events as RawEvent[];

/** Reads a captured event by index, failing loudly if the fixture is short. */
function rawEvent(source: RawEvent[], index: number): RawEvent {
  const event = source[index];
  if (event === undefined) throw new Error(`fixture has no event at index ${index}`);
  return event;
}

/** A captured Factory event in the shape the RPC client produces. */
export function factoryEvent(index: number): RpcEvent {
  return toRpcEvent(rawEvent(rawFactoryEvents, index));
}

/** A captured Group event in the shape the RPC client produces. */
export function groupEvent(index: number): RpcEvent {
  return toRpcEvent(rawEvent(rawGroupEvents, index));
}

export const factoryEvents: RpcEvent[] = rawFactoryEvents.map(toRpcEvent);
export const groupEvents: RpcEvent[] = rawGroupEvents.map(toRpcEvent);
export const allEvents: RpcEvent[] = [...factoryEvents, ...groupEvents];

/** Decodes and asserts success, returning the event for further assertions. */
export function decodeOk(event: RpcEvent): DecodedChainEvent {
  const result = decodeChainEvent(event);
  if (!result.ok) throw new Error(`expected a decoded event, got: ${result.reason}`);
  return result.event;
}
