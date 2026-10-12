/**
 * Decoder tests.
 *
 * The inputs are real events captured from Stellar Testnet (see
 * `fixtures/chain_events.json`), so these tests fail if the decoder stops
 * agreeing with the bytes the contracts actually emit. Hand-written XDR would
 * only prove the decoder agrees with our assumptions about the contracts.
 */

import { assertEquals, assertNotEquals } from '@std/assert';
import { decodeChainEvent, decodeChainEvents } from '../supabase/functions/_shared/decode.ts';
import type { RpcEvent } from '../supabase/functions/_shared/stellar.ts';
import {
  allEvents,
  decodeOk,
  FACTORY_ID,
  factoryEvents,
  GROUP_ID,
  groupEvent,
  groupEvents,
  symbolTopic,
} from './fixture.ts';

Deno.test('every captured Testnet event decodes', () => {
  const { events, rejected } = decodeChainEvents(allEvents);

  assertEquals(rejected, []);
  assertEquals(events.length, allEvents.length);
  assertEquals(events.length, 29);
});

Deno.test('the captured events cover both contracts and their full vocabulary', () => {
  const { events } = decodeChainEvents(allEvents);

  const names = [...new Set(events.map((event) => event.name))].sort();
  assertEquals(names, [
    'completed',
    'contribution',
    'fee',
    'fee_updated',
    'group_created',
    'join',
    'pause_updated',
    'payout',
    'start',
    'treasury_updated',
  ]);

  const contracts = [...new Set(events.map((event) => event.contractId))].sort();
  assertEquals(contracts, [FACTORY_ID, GROUP_ID].sort());
});

Deno.test('group_created carries the creator, group, token and terms', () => {
  const event = factoryEvents.map(decodeOk).find((e) => e.name === 'group_created');
  if (event?.name !== 'group_created') throw new Error('no group_created event in the fixture');

  assertEquals(event.contractId, FACTORY_ID);
  assertEquals(event.groupId, 6);
  assertEquals(event.memberCapacity, 3);
  // 100000000 base units at 7 decimals is 10 USDC.
  assertEquals(event.contributionAmount, '100000000');
  assertEquals(event.creator.startsWith('G'), true);
  assertEquals(event.group.startsWith('C'), true);
  assertEquals(event.token.startsWith('C'), true);
});

Deno.test('a contribution decodes its member, round and amount', () => {
  const event = groupEvents.map(decodeOk).find((e) => e.name === 'contribution');
  if (event?.name !== 'contribution') throw new Error('no contribution event in the fixture');

  assertEquals(event.round, 1);
  assertEquals(event.amount, '100000000');
  assertEquals(event.member.startsWith('G'), true);
});

Deno.test('fee_updated decodes its basis-point fee', () => {
  const event = factoryEvents.map(decodeOk).find((e) => e.name === 'fee_updated');
  if (event?.name !== 'fee_updated') throw new Error('no fee_updated event in the fixture');

  assertEquals(event.contractId, FACTORY_ID);
  assertEquals(event.feeBps, 250);
});

Deno.test('fee_updated with a wrong topic count is rejected', () => {
  const base = factoryEvents.find((e) => {
    const r = decodeChainEvent(e);
    return r.ok && r.event.name === 'fee_updated';
  });
  if (!base) throw new Error('no fee_updated event in the fixture');
  // fee_updated expects exactly 2 topics; a third topic must fail, not decode.
  const extraTopic = { ...base, topic: [...base.topic, symbolTopic('extra')] };

  const result = decodeChainEvent(extraTopic);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason.includes('expects 2 topics'), true);
});

Deno.test('treasury_updated decodes the treasury address from its topic', () => {
  const event = factoryEvents.map(decodeOk).find((e) => e.name === 'treasury_updated');
  if (event?.name !== 'treasury_updated') {
    throw new Error('no treasury_updated event in the fixture');
  }

  assertEquals(event.contractId, FACTORY_ID);
  assertEquals(event.treasury.startsWith('G'), true);
});

Deno.test('treasury_updated with a wrong topic count is rejected', () => {
  const base = factoryEvents.find((e) => {
    const r = decodeChainEvent(e);
    return r.ok && r.event.name === 'treasury_updated';
  });
  if (!base) throw new Error('no treasury_updated event in the fixture');
  // treasury_updated expects exactly 3 topics; dropping the address topic must fail.
  const missingTopic = { ...base, topic: base.topic.slice(0, 2) };

  const result = decodeChainEvent(missingTopic);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason.includes('expects 3 topics'), true);
});

Deno.test('pause_updated decodes its paused flag', () => {
  const event = factoryEvents.map(decodeOk).find((e) => e.name === 'pause_updated');
  if (event?.name !== 'pause_updated') throw new Error('no pause_updated event in the fixture');

  assertEquals(event.contractId, FACTORY_ID);
  assertEquals(event.paused, true);
});

Deno.test('pause_updated with a non-boolean paused flag is rejected', () => {
  const base = factoryEvents.find((e) => {
    const r = decodeChainEvent(e);
    return r.ok && r.event.name === 'pause_updated';
  });
  if (!base) throw new Error('no pause_updated event in the fixture');
  // A u32 where a bool is expected: valid XDR map, wrong value type.
  const wrongType = {
    ...base,
    value: 'AAAAEQAAAAEAAAABAAAADwAAAAZwYXVzZWQAAAAAAAMAAAAB',
  };

  const result = decodeChainEvent(wrongType);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason.includes('malformed'), true);
});

Deno.test('amounts stay exact integers rather than becoming numbers', () => {
  const { events } = decodeChainEvents(allEvents);

  for (const event of events) {
    for (const [field, value] of Object.entries(event)) {
      if (field === 'amount' || field === 'recipientAmount' || field === 'fee') {
        assertEquals(
          typeof value,
          'string',
          `${field} must be a string so no precision is lost`,
        );
      }
      assertNotEquals(
        typeof value,
        'bigint',
        `${field} must not leak a bigint out of the decoder`,
      );
    }
  }
});

Deno.test('a payout and its fee describe the same round and split the pool', () => {
  const { events } = decodeChainEvents(allEvents);

  const payout = events.find((e) => e.name === 'payout');
  const fee = events.find((e) => e.name === 'fee');
  if (payout?.name !== 'payout' || fee?.name !== 'fee') {
    throw new Error('expected a payout and a fee in the fixture');
  }

  assertEquals(payout.round, 1);
  assertEquals(fee.round, 1);

  // 30 USDC pool: 0.15 fee, 29.85 to the recipient.
  assertEquals(payout.recipientAmount, '298500000');
  assertEquals(fee.fee, '1500000');
  assertEquals(
    BigInt(payout.recipientAmount) + BigInt(fee.fee),
    BigInt('300000000'),
  );
});

Deno.test('the group lifecycle ends with a completed event naming the round count', () => {
  const event = groupEvents.map(decodeOk).find((e) => e.name === 'completed');
  if (event?.name !== 'completed') throw new Error('no completed event in the fixture');

  assertEquals(event.rounds, 3);
});

Deno.test('coordinates are preserved so an event can be traced back to the chain', () => {
  const event = decodeOk(groupEvent(0));

  assertEquals(event.contractId, GROUP_ID);
  assertEquals(event.ledger > 0, true);
  assertEquals(/^[0-9a-f]{64}$/.test(event.txHash), true);
  // The RPC's paging token is kept so an indexed row can be re-fetched.
  assertEquals(event.eventId, groupEvent(0).id);
});

Deno.test('an unknown event name is rejected, not guessed at', () => {
  const base = groupEvent(0);
  // "join" replaced by "join_extra": same shape, name we do not know.
  const unknownName = {
    ...base,
    topic: [base.topic[0] as string, symbolTopic('join_extra')],
  };

  const result = decodeChainEvent(unknownName);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason.includes('unknown event name'), true);
});

Deno.test('an event from another namespace is rejected', () => {
  const base = groupEvent(0);
  // "susu" replaced by "acme".
  const foreign = { ...base, topic: [symbolTopic('acme'), base.topic[1] as string] };

  const result = decodeChainEvent(foreign);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason.includes('namespace'), true);
});

Deno.test('a topic count that does not match the event is rejected', () => {
  const base = groupEvent(0);
  // A join with its member topic removed: a near-miss that must not be read as
  // a join without a member.
  const missingTopic = { ...base, topic: [base.topic[0] as string, base.topic[1] as string] };

  const result = decodeChainEvent(missingTopic);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason.includes('expects 3 topics'), true);
});

Deno.test('undecodable XDR in a topic is rejected rather than skipped', () => {
  const base = groupEvent(0);
  const corrupt = { ...base, topic: [base.topic[0] as string, 'not-valid-base64-xdr'] };

  const result = decodeChainEvent(corrupt);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason.includes('not decodable XDR'), true);
});

Deno.test('a value that is not a map is rejected', () => {
  const base = groupEvent(0);
  // A bare symbol where a map of fields is expected: valid XDR, wrong shape.
  const notAMap = { ...base, value: base.topic[0] as string };

  const result = decodeChainEvent(notAMap);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason.includes('not a map'), true);
});

Deno.test('a rejected event does not discard the rest of its batch', () => {
  const base = groupEvent(0);
  const bad = { ...base, value: base.topic[0] as string };

  const { events, rejected } = decodeChainEvents([bad, ...groupEvents]);

  assertEquals(rejected.length, 1);
  assertEquals(rejected[0]?.eventId, base.id);
  assertEquals(events.length, groupEvents.length);
});

Deno.test('a rejected event keeps its chain coordinates so it can be located', () => {
  const base = groupEvent(0);
  const bad = { ...base, value: base.topic[0] as string };

  const { rejected } = decodeChainEvents([bad]);

  assertEquals(rejected.length, 1);
  const event = rejected[0];
  if (event === undefined) throw new Error('expected one rejected event');
  assertEquals(event.eventId, base.id);
  assertEquals(event.contractId, base.contractId);
  assertEquals(event.ledger, base.ledger);
  assertEquals(event.txHash, base.txHash);
  assertEquals(event.txIndex, base.txIndex);
  assertEquals(event.eventIndex, base.eventIndex);
  assertEquals(event.reason.includes('not a map'), true);
});

Deno.test('an event from an unsuccessful contract call is rejected', () => {
  const contribution = groupEvents.find((e) => decodeOk(e).name === 'contribution');
  if (contribution === undefined) throw new Error('no contribution event in fixture');

  const failedContribution: RpcEvent = { ...contribution, successful: false };
  const contribResult = decodeChainEvent(failedContribution);
  assertEquals(contribResult.ok, false);
  if (!contribResult.ok) {
    assertEquals(contribResult.reason.includes('unsuccessful contract call'), true);
  }

  const payout = groupEvents.find((e) => decodeOk(e).name === 'payout');
  if (payout === undefined) throw new Error('no payout event in fixture');

  const failedPayout: RpcEvent = { ...payout, successful: false };
  const payoutResult = decodeChainEvent(failedPayout);
  assertEquals(payoutResult.ok, false);
  if (!payoutResult.ok) {
    assertEquals(payoutResult.reason.includes('unsuccessful contract call'), true);
  }
});

Deno.test('decodeChainEvents excludes unsuccessful events and counts them in rejected', () => {
  const contribution = groupEvents.find((e) => decodeOk(e).name === 'contribution');
  if (contribution === undefined) throw new Error('no contribution event in fixture');

  const failedContribution: RpcEvent = {
    ...contribution,
    id: 'test-failed-event-id',
    successful: false,
  };
  const { events, rejected } = decodeChainEvents([failedContribution, ...allEvents]);

  assertEquals(rejected.length, 1);
  assertEquals(rejected[0]?.eventId, 'test-failed-event-id');
  assertEquals(rejected[0]?.reason.includes('unsuccessful contract call'), true);
  assertEquals(events.length, allEvents.length);
});

Deno.test('an event with missing or non-true successful flag is rejected', () => {
  const contribution = groupEvents.find((e) => decodeOk(e).name === 'contribution');
  if (contribution === undefined) throw new Error('no contribution event in fixture');

  const missingSuccessful = { ...contribution } as unknown as RpcEvent;
  delete (missingSuccessful as Record<string, unknown>)['successful'];

  const result = decodeChainEvent(missingSuccessful);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.reason.includes('unsuccessful contract call'), true);
  }
});
