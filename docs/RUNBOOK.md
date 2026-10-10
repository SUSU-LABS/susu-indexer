# Runbook — susu-indexer

Operational procedures for the scheduled indexer.

## Core principle

The index is a **rebuildable cache** of chain activity. Chain state is authoritative. If the two
disagree, the chain is correct and the index is repaired — never the other way round.

## Health signals

- **Checkpoint:** `select * from indexer_checkpoints;`
- **Lag:** compare `last_processed_ledger` to the network's current ledger.
- **Open alerts:**
  `select kind, subject, detail, opened_at, notified_at from indexer_alerts where resolved_at is null order by opened_at desc;`
- **Failed runs:**
  `select * from indexer_runs where status = 'failed' order by created_at desc limit 20;`
- **Cron history:**
  `select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'susu-indexer') order by start_time desc limit 20;`

A checkpoint that stops advancing, or a growing lag, means scheduled runs are failing or cannot keep
up.

**The lag has a hard ceiling, and it is the one number worth alerting on.** Soroban RPC only serves
events from a rolling window (7 days on Testnet, which at 5s per ledger is roughly 120,000 ledgers).
A lag approaching that window is not a performance problem, it is a deadline: past it, runs cannot
succeed at all, and the events that fell out of the window are gone permanently. See
[the checkpoint fell behind retention](#the-checkpoint-fell-behind-the-rpcs-retention-window).

## Alerts, and what they are for

The lag above is the number that matters, so something has to be watching it rather than waiting for
someone to look. `public.check_indexer_health()` runs every fifteen minutes under the
`susu-indexer-health` cron job and watches four conditions:

| Kind               | What it means                                                                |
| ------------------ | ---------------------------------------------------------------------------- |
| `stale_checkpoint` | The checkpoint has not advanced in 30 minutes — three missed runs            |
| `failed_run`       | The indexer recorded a failure in the last hour, with its reason             |
| `rejected_events`  | The decoder refused an event in the last hour — the interface may have moved |
| `failed_schedule`  | A scheduled invocation did not succeed, including ones that never started    |

Staleness is checked before lag on purpose. It needs no RPC, no secret and no quota, and a
checkpoint that stops moving is how lag grows in the first place — so this notices the problem while
fixing it is still trivial.

**One alert per condition, not one per check.** A partial unique index permits a single open row per
`(kind, subject)`, so a condition that is still true refreshes that row's detail instead of opening
another, and a condition that clears resolves the row rather than deleting it. The check can
therefore run as often as anything likes and the result is the same. History stays readable: what
broke, what it said, and when it stopped.

To see what is open, and whether anyone was told:

```sql
select kind, subject, detail, opened_at, notified_at
from public.indexer_alerts
where resolved_at is null
order by opened_at desc;
```

There is no acknowledgement step. An alert closes when the condition closes, and a condition that
keeps recurring is telling you it was never fixed.

### Being told rather than looking

Recording an alert is not the same as delivering one. To have alerts delivered, store a webhook URL
in Vault — a chat channel's incoming webhook is enough:

```sql
select vault.create_secret('<webhook-url>', 'indexer_alert_webhook',
                           'Where indexer health alerts are posted');
```

A newly opened alert is then posted there, and its `notified_at` is set **only after the webhook
answers with a 2xx status**. Delivery is at-least-once: a failed, non-2xx, or unanswered webhook
leaves `notified_at` null, so the next check retries it — and a slow webhook can therefore deliver
twice. If no webhook is stored, **alerts are still recorded and nothing is sent** — an open alert
with a null `notified_at` is one nobody was told about. That is the difference between having
alerting and having a table.

### Running the check by hand

```sql
select * from public.check_indexer_health();                    -- real thresholds, delivers
select * from public.check_indexer_health('0 seconds', '1 hour', false);  -- trips the stale check
```

The second form makes the staleness threshold zero, so the current checkpoint trips it. Inside a
transaction that is rolled back, it is a safe way to confirm detection works on a healthy system.
The returned row counts what the run opened, resolved, left open, and notified.

### The alert functions are not for browsers

`check_indexer_health()` is `security definer`, because it reads `cron.job_run_details` and
`vault.decrypted_secrets`, which `service_role` cannot read for itself. Its `search_path` is
therefore fixed, and `execute` is revoked from `public`, `anon` and `authenticated` — a definer
function with a caller-controlled `search_path` is a privilege escalation, and one that any browser
can call is a liability.

## Procedures

### The checkpoint is stale

1. Check `indexer_runs` for failure reasons.
2. Confirm the RPC endpoint is reachable and the Supabase function is deployed.
3. Confirm the invocation secret in Vault matches `INDEXER_TASK_SECRET` on the function.
4. Trigger a run manually (see below) and confirm the checkpoint advances.

A missed schedule is **not** data loss: the next run resumes from the checkpoint and retries the
whole unprocessed range.

### Trigger a run manually

```bash
curl -i --fail-with-body \
  -X POST "$SUPABASE_URL/functions/v1/indexer" \
  -H "x-indexer-task-secret: $INDEXER_TASK_SECRET" \
  -H "content-type: application/json" \
  -d '{}'
```

Never paste the secret into a shared terminal history or a log. Prefer exporting it from a secret
manager for the duration of the command.

### Runs are failing repeatedly

1. Read the `reason` column — it names the failure class, never a credential.
2. If it is an RPC fault, wait for retry; backoff is bounded per run.
3. If it is a validation fault, an event shape may have changed. Do **not** loosen validation to
   force the run through — a bad amount must never be coerced into a valid one. Escalate.

### Index state diverges from chain state

A group's derived figures are recomputed from its recorded facts on every run, and a disagreement
with what was stored is logged as
`Group state disagreed with the recorded facts; repaired from
them`, with a `divergences` count and
up to five `examples` naming the field, the stored value, and the derived one.

1. Read the logged divergence.
2. If a fact is missing rather than wrong, the fault is in discovery or paging rather than in state
   derivation — re-indexing repairs the symptom, but the cause is the bug to fix.
3. Confirm the repaired figures against chain state.

### A group's activity is missing or incomplete

A group is only ever learned about from the Factory's `group_created` event, and only from inside a
range that is read. The checkpoint has already moved past that range by the time the symptom is
visible, so a rebuild is required. Two distinct faults produce the same symptom:

- the range was processed before group discovery existed, so the group's contract was never watched;
- the range was read incompletely, so some of its events were never fetched.

1. Confirm the group exists on-chain and note its creation ledger.
2. Reset the checkpoint to the ledger **before** that group's creation ledger (see below), provided
   that ledger is not below the RPC's retention floor — if it is, the creation event is already gone
   and the group cannot be rediscovered; see
   [the checkpoint fell behind retention](#the-checkpoint-fell-behind-the-rpcs-retention-window).
3. Let runs work forward, then confirm the group appears in `groups` with its facts in
   `group_members`, `contributions`, `payouts` and `protocol_fees`.

### The checkpoint fell behind the RPC's retention window

The RPC serves events only from a rolling window, and it rejects — rather than truncates — a request
that starts before it:

```
-32600: startLedger must be within the ledger range: 4525191 - 4646150
```

The whole request fails, including the part of the range that is still available. So once
`last_processed_ledger` sits below the window's floor, **every run fails and keeps failing**;
nothing advances the checkpoint, and the gap only grows. The error names both bounds, which is the
quickest way to read the current floor without the dashboard.

This is a permanent-loss situation, not a delay. The events between the old checkpoint and the floor
are no longer obtainable from this RPC, so no retry and no rebuild can recover them.

To recover:

1. Confirm the low edge of the window from the error above.
2. Reset the checkpoint to the floor itself, never below it:
   ```sql
   update public.indexer_checkpoints
   set last_processed_ledger = :retention_floor - 1,
       start_ledger = :retention_floor
   where id = 'default';
   ```
3. Record the gap. Every event in it is missing, and a group whose creation fell inside it has no
   `groups` row and will never be discovered, because discovery reads the Factory's `group_created`
   event and that event is gone. If a group is missing, it has to be seeded from chain state
   directly; there is nothing to re-index.
4. Treat the derived figures for any group that was active across the gap as suspect. Totals are
   recomputed from recorded facts, so a missing contribution is silently absent from the sum rather
   than flagged. Compare against chain state before trusting them.

Prevention is the point: alert on lag well before it reaches the window, and never let a schedule
stay paused for longer than it.

### Full rebuild

A rebuild can only reach back as far as the retention floor, not to the Factory's deployment ledger.
If the deployment is older than the window, the first ledgers are unreachable and the rebuild is
**partial** — read
[the checkpoint fell behind retention](#the-checkpoint-fell-behind-the-rpcs-retention-window) first,
and follow its step 3 for any group created before the floor.

1. Note the Factory deployment ledger, and compare it to the retention floor. Use whichever is later
   — a start ledger below the floor guarantees failure.
2. Reset the checkpoint:
   ```sql
   update public.indexer_checkpoints
   set last_processed_ledger = :start_ledger - 1,
       start_ledger = :start_ledger
   where id = 'default';
   ```
3. Let scheduled runs work through the history. Progress is durable between runs.
4. Optionally truncate `indexed_events` and the chain-derived tables (`decoded_events`, `groups`,
   `group_members`, `contributions`, `payouts`, `protocol_fees`) first if a clean rebuild is
   preferred — the indexer repopulates all of them. Never truncate anything the contracts depend on;
   nothing off-chain is a dependency of the contracts.

### The invocation secret is compromised

1. Generate a new secret (`openssl rand -hex 32`).
2. Update the Edge Function secret and the Vault entry.
3. Confirm the old secret is rejected.
4. Review `indexer_runs` and function logs for unauthorised invocations.

### Pausing indexing

```sql
select cron.unschedule('susu-indexer');
```

Indexing resumes from the checkpoint whenever the schedule is restored.

## Escalation

Any change to event identity, checkpoint semantics, or index table access requires human review
before implementation. Never weaken validation or RLS to work around an operational problem.
