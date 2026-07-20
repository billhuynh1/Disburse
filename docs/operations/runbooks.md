# Phase 6 operational runbooks

Use `GET /api/internal/operations/snapshot` with `Authorization: Bearer $OPERATIONAL_SNAPSHOT_SECRET`. The response is read-only, uncached, payload-free, and includes active checks. Never paste secrets, payloads, transcript text, signed URLs, provider responses, or raw idempotency keys into incidents.

## Cron failure

Confirm the Cron authorization secret is present and that the latest invocation failed. Check deployment logs only for allowlisted `pipeline.invocation_failed` fields. Trigger one authenticated staging Cron request. If internal processing still works, repair Cron configuration; otherwise enable the kill switch and follow scheduler/provider guidance. Success means a later Cron invocation completes and queue age decreases.

`cron_missing` applies only when Cron is expected and has never run. `cron_stale` applies only to a recorded invocation whose age is strictly greater than 900 seconds; equality does not alert, and the two states are mutually exclusive.

## Scheduler stall

Compare queue depth, oldest age, heartbeat age, ownership, capacity, and kill-switch state. Do not clear owner tokens manually. Wait one lease window for safe takeover, then invoke Cron once. If ownership remains stuck after expiry, capture the snapshot and escalate before any database repair. Success means heartbeat and reconciliation progress advance.

## Lease takeover

Inspect expired lease count and the scheduler expired-owner indicator. Let the accepted recovery path reclaim leases; never edit lease tokens. Confirm the old processor cannot finalize with its stale token and the successor completes once. Escalate if expired leases grow for two Cron intervals.

## Reconciliation stall

Record cursor, cycle, progress age, queue depth, and lock/capacity indicators. Invoke one staging-safe Cron pass. If the cursor does not advance, use deterministic reconciliation interruption tests before a forward fix. Never replay external effects directly.

While the scheduler heartbeat is current, missing reconciliation progress or progress age strictly greater than 900 seconds alerts independently of queue depth. Equality does not alert. A heartbeat is activity evidence, not progress; only cursor movement or cycle completion refreshes reconciliation progress.

## Ambiguous effects

Stop automatic recovery for the affected lineage. Identify provider and checkpoint state from safe identifiers only, then verify provider-side outcome using approved provider tooling. Resume from a completed checkpoint only when its typed result is durable; otherwise require manual disposition. Never guess and never replay an ambiguous send.

## Deletion stall

Check backlog age, active leases, uploads completing, and storage provider health. Allow cancellation fencing and cleanup Cron to retry. Do not delete database rows before storage and lease barriers agree. Success requires both storage deletion state and database finalization.

## Recovery budget exhaustion

Inspect typed failure class, checkpoint status, attempt/max-attempt counts, and latest recovery outcome. Do not increase the budget during an incident. Correct the cause, then choose a reviewed forward fix or a new generation; publishing recovery remains prohibited.

## Provider outage

Determine whether failures cluster at OpenAI, S3, media, render, or facecam boundaries. Check provider status and credentials without logging values. Enable the kill switch if retries amplify load. Resume with a canary after the provider recovers and confirm failure rate and queue age fall.

## Audit growth

Compare the current and previous 24-hour payload-free audit counts. Confirm whether growth corresponds to queue volume, repeated Cron failures, or recovery attempts. Do not delete audit rows during an incident; stop retry amplification with the kill switch and forward-fix the source.

## Migration failure

Stop deployment before application rollout. Run `npm run ops:preflight -- --require-env --database` against the intended environment. If the additive migration did not commit, fix and retry it. If it committed and application compatibility is intact, forward-fix; never drop the table or run `drizzle-kit push`.
