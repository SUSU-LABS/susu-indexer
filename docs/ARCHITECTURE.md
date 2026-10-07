# Architecture — susu-indexer

> Phase 5 in progress.

## Role

The indexer converts chain activity into queryable index state. It is a **consumer** of chain data,
never a participant in financial decisions.

```text
Stellar RPC ──events──> Indexer Edge Function ──upsert──> PostgreSQL
                              │
                              ├─ checkpoint (last fully processed ledger)
                              ├─ event identity (idempotent key)
                              └─ run log (operational visibility)
```

## Invocation model

```text
Supabase Cron (every 5 minutes)
   │  reads secret from Vault
   ▼
public.invoke_indexer()  ──HTTP──>  Edge Function `indexer`
                                        │
                                        ├─ authorise (constant-time secret compare)
                                        ├─ load checkpoint + chain tip
                                        ├─ compute bounded ledger range
                                        ├─ read the watch list (factory, token, known groups)
                                        ├─ fetch events (cursor-paged, retried)
                                        ├─ decode XDR into typed events
                                        ├─ discover groups announced in this range
                                        ├─ re-read the range for the groups just discovered
                                        ├─ order, deduplicate by event identity
                                        ├─ record raw events, then project the facts
                                        ├─ recompute each touched group's state
                                        └─ advance checkpoint (forward only)
```

## Guarantees

| Guarantee                      | Mechanism                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------- |
| No duplicate rows              | Unique `event_identity` (`contractId:ledger:txHash:eventIndex`)                  |
| Stable event identity          | `eventIndex` is the ledger-scoped ordinal from the RPC's paging token            |
| Only successful calls          | Events from failed contract calls are never indexed                              |
| Replay-safe                    | Upserts ignore conflicts rather than overwriting                                 |
| Exact money                    | Amounts are summed as `BigInt`; `numeric` is read with an explicit `::text` cast |
| State derived, not accumulated | Totals are recomputed from facts, so a replay corrects rather than inflates      |
| No skipped ledgers             | Range resumes at `checkpoint + 1`; checkpoint advances only after writes succeed |
| Complete range reads           | Paging follows the RPC's cursor; a full page without one fails the run           |
| Group events are indexed       | Group contracts are discovered from `group_created` and read in the same run     |
| Bounded runtime                | Range capped at `INDEXER_MAX_LEDGER_RANGE` per run                               |
| Retryable failures             | Bounded exponential backoff; checkpoint untouched on failure                     |
| Not publicly triggerable       | Shared secret, constant-time comparison, fails closed                            |
| No credential leakage          | Recursive log redaction; secret read from Vault at call time                     |
| Browser isolation              | RLS enabled with no policies; `anon`/`authenticated` revoked                     |

### Event identity

The RPC does **not** return a per-transaction event index. It returns `id`, a paging token of the
form `<ledger-token>-<ordinal>`, where the ordinal counts events across the whole ledger. The
ordinal is extracted from that token and used as `eventIndex`.

This is worth stating explicitly because the obvious alternative is wrong in a way that only shows
up under pagination. Deriving the index from an event's position within a response page looks
correct until a busy range is split across pages, at which point the same event acquires a different
position, and therefore a different identity, and is indexed a second time.

### Decoding

`decode.ts` turns base64 XDR into typed events and rejects anything it cannot fully recognise. A
payload that is merely _almost_ understood is never coerced into something plausible: an unreadable
amount is not zero, and an event with the wrong number of topics is not a near-miss to be patched
up. Rejected events are counted and skipped; a misread event becomes a wrong balance.

The expected shapes are asserted against bytes captured from Testnet, in
`tests/fixtures/chain_events.json`, so the tests fail if the decoder stops agreeing with what the
contracts actually emit rather than merely with what we assumed they emit.

### Only successful calls

Contract events are emitted during failed calls as well as successful ones. Indexing one would
record a contribution or a payout that never happened, so an event whose emitting call did not
succeed — or whose status the RPC did not state — is not indexed.

### Reading a range in full

The checkpoint only moves forward, so a range that is read incompletely is never read again:
whatever the missing events said about money moving is simply absent, and absent looks exactly like
never happened. Paging therefore follows the RPC's own cursor, and a full page that arrives without
one fails the run rather than being treated as the end. The checkpoint is left alone, so the range
is retried.

An earlier version advanced the next request's `startLedger` to the highest ledger in the previous
page. A page filled entirely by one ledger — a busy group, a payout round — left that ledger's
remaining events on the far side of the boundary and skipped them.

A range is also read through one filter per five contracts, because that is all the RPC accepts: a
sixth ID in a single filter is rejected outright with
`-32602: filter 1 invalid: maximum 5
contract IDs per filter`. The watch list therefore grows into a
constraint rather than staying a convenience — past five groups, the second discovery pass has more
contracts to watch than one filter can carry, and every run fails until the list is split. Reading
the chunks one after another keeps the load on a shared public endpoint predictable, and
de-duplicating the list first stops a repeated address from spending one of the five slots.

### Watching a group

The Factory deploys each group as its own contract, so a group's events are emitted by an address
nobody knows in advance. The only place it appears is the Factory's `group_created` event.

That makes discovery a prerequisite for reading anything a group does, and it puts discovery and the
checkpoint in tension: a group is normally created and used within a single range, and the
checkpoint moves past that range when the run ends. Registering the group and waiting for the next
run to read its events would skip them permanently, because the next run begins after the ledgers
they are in. The range is read a second time instead, for the contracts discovered in it.

One extra pass is enough. Only the Factory emits `group_created`, and the second pass watches group
contracts alone, so it cannot discover anything further.

### Derived state and reconciliation

Group state is never accumulated. Every figure — member count, round, totals — is recomputed from
the recorded facts by `state.ts`, and written back. A running total maintained by deltas would
double-count the first time a range was replayed, and nothing downstream could tell that it had.

This is what makes "the chain wins and reconciliation repairs the index" a property of the code
rather than an intention: if stored state disagrees with the facts, recomputing overwrites it.
Divergence is logged rather than merely corrected, because state that drifted without a replay means
something else is wrong.

A group that has never been derived is not reported as divergent. Discovery writes placeholder
figures, so the first derivation always differs from them, and treating that as drift would bury the
real signal in first-run noise. `last_event_ledger` is the marker: zero means no derivation has run.

Writing the derived figures is an `UPDATE`, and it cannot be an upsert. Postgres checks a row's
`NOT NULL` constraints against the tuple an `INSERT` proposes _before_ it resolves `ON CONFLICT`
against an existing row, and `groups` holds the group's identity — factory, id, creator, token,
terms — as `NOT NULL` columns with no defaults. Reconciliation knows only the derived figures, so an
upsert fails on the first row with `null value in column "factory_contract_id"` even though the
conflicting row exists and already holds every one of those values. Updating also states the intent
honestly: reconciliation corrects a group discovery has already recorded, and it never creates one.

## Storage

Operational tables:

| Table                     | Purpose                                                     |
| ------------------------- | ----------------------------------------------------------- |
| `indexer_checkpoints`     | Last fully processed ledger and rebuild origin              |
| `indexed_events`          | Raw chain events, deduplicated by chain-derived identity    |
| `indexer_runs`            | Append-only log of **failures**, for monitoring             |
| `indexer_alerts`          | One row per health condition, open until it clears          |
| `indexer_rejected_events` | Raw events the decoder refused, with reason and coordinates |

`indexer_runs` records failures only, on purpose: the run log exists so a failure's reason is
readable, and a successful run leaves its evidence in `indexer_checkpoints.updated_at` advancing.
That makes the checkpoint's timestamp the liveness heartbeat — a stopped indexer is one whose
checkpoint stops moving.

`indexer_rejected_events` records every event the decoder could not recognise, keyed by the RPC's
paging token so re-reading a range cannot duplicate it. A rejection is the highest-consequence
silent failure — a decoder miss means the contract interface moved and can hide a real contribution
or payout — so the indexer writes these before it may advance the checkpoint, and the health check
alerts on them.

`indexer_alerts` is written by `check_indexer_health()`, scheduled every fifteen minutes. It watches
four conditions — a stale checkpoint, a recorded failure, a rejected event, and a scheduled
invocation that did not succeed — and holds exactly one open row per condition, refreshing it while
the condition persists and resolving it when it clears. Open rows with a null `notified_at` are
alerts nobody was told about, which happens when no webhook is configured. See
[the runbook](RUNBOOK.md#alerts-and-what-they-are-for).

Chain-derived tables, each rebuildable from the one before it:

| Table            | Purpose                                                     |
| ---------------- | ----------------------------------------------------------- |
| `decoded_events` | Every event the decoder understood, with amounts as strings |
| `groups`         | Groups, their terms, and the indexer's watch list           |
| `group_members`  | Membership in the position the chain assigned               |
| `contributions`  | One row per contribution                                    |
| `payouts`        | One row per payout, net of the protocol fee                 |
| `protocol_fees`  | The treasury's share of each payout                         |

The chain remains authoritative for all of them. They carry the constraints the chain enforces — one
contribution per member per round, one payout per round, one member per position — so a wrong
reading of the events fails loudly at the write instead of being trusted.

Amounts are `numeric(39,0)`, because the largest `i128` is 39 digits and `bigint` would overflow it.
Reads that cross into JavaScript must cast to `text`: PostgREST renders `numeric` as a JSON number,
and JavaScript loses integers above 2^53. The reads in `db.ts` do this, and `sumAmounts` refuses a
value that is not an integer string, so dropping a cast fails loudly rather than rounding a total in
silence.

No table here is reachable from a browser. RLS is enabled with no policies on every one of them, and
`anon` and `authenticated` hold no privileges.

## Deliberate non-goals

- No transaction submission or signing.
- No financial authority of any kind.
- No always-on worker for the MVP — scheduled execution is sufficient given idempotent, resumable
  runs.
