# Phase 6 deployment verification

1. Build and test the exact commit. Run `npm run ops:preflight` locally.
2. Before migration, run `npm run ops:preflight -- --require-env` against the exact artifact. Stop on any journal or environment failure.
3. Apply `0034` then additive `0035_operational_verification_remediation.sql` through `drizzle-kit migrate`; review both files first. Never use `drizzle-kit push`.
4. After migration and before application deployment, run `npm run ops:preflight -- --require-env --database`. It verifies the journal, tables, columns, constraints, and indexes without printing secrets.
5. Deploy with `DISBURSE_PIPELINE_KILL_SWITCH=true`, fault injection disabled, and an independent snapshot secret.
6. Verify the protected snapshot reports schema version 35, then canary one small non-sensitive upload with the kill switch disabled for one controlled processor pass.
7. Confirm queue age/depth, heartbeat, dedicated reconciliation progress, checkpoints, deletion/recovery state, audit growth, and alerts. Expand normally only after two healthy Cron intervals.

Rollback is acceptable only before migration commit or when reverting application code remains compatible with the additive table. Forward-fix when jobs or checkpoints have advanced, the migration committed, an external effect may have been sent, deletion began, or rollback could violate fencing. Keep the kill switch enabled while deciding. Never roll back by deleting operational records or durable checkpoints.

The kill switch stops new processor acquisition and job execution but does not broaden authority or cancel in-flight work. Direct publishing is fenced in user actions, enqueue, processing, recovery, and provider services.
