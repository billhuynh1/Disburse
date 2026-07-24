# Phase 6 Batch A — Migrations

## Objective

Make Phase 6 migrations executable after accepted migration 0033 while preserving heartbeat-independent reconciliation progress.

## Exact findings covered

- Critical: migrations 0034/0035 have journal timestamps earlier than accepted 0033 and are skipped.
- Medium: migration 0035 backfills reconciliation progress from generic scheduler `updated_at`.

## Invariants

- Accepted migration 0033 remains byte-identical.
- Journal order, indices, timestamps, SQL files, and snapshot ancestry agree.
- Heartbeat, ownership, and release activity never count as reconciliation progress.
- Historical state is never silently rewritten or invented.

## In scope

- Migration 0034/0035 journal timestamps and metadata consistency.
- Migration 0035 reconciliation-progress initialization.
- Migration/preflight contract validation.
- Fresh-install and accepted-0033 upgrade tests.

## Out of scope

- Provider signals, classifications, capacity counting, event correlation, and the fault matrix.
- Historical 0020/0022 remediation.
- External database migration or deployment.

## Required implementation behavior

- Assign deterministic, strictly increasing 0034/0035 timestamps greater than 0033 timestamp `1784508809302`.
- Reject duplicate, decreasing, missing, unexplained, or index-inconsistent journal entries in preflight.
- Preserve exact snapshot `prevId` chaining.
- Leave unknown historical `reconciliation_progress_at` as `NULL`; do not derive it from `updated_at`.
- Update progress time/count only on genuine cursor movement or cycle completion.
- Preserve null-to-null, wrap-false no-op behavior.

## Required tests

- Upgrade a real PostgreSQL 16 database from accepted 0033 and prove 0034/0035 execute in order.
- Migrate a fresh empty database through 0035.
- Reject the original non-monotonic and duplicate timestamp states.
- Verify expected tables, columns, constraints, indexes, migration hashes, and created-at order.
- Verify heartbeat/release do not change progress; cursor movement and cycle completion do.
- Verify live heartbeat plus `NULL` progress yields the documented stall state.

## Acceptance criteria

- Both real migration paths pass with zero skipped migration tests.
- Preflight detects every invalid journal case.
- No progress timestamp is inferred from generic activity.
- Diff is limited to Batch A paths and independently accepted.

## Verification commands

```bash
PHASE1A_TEST_DATABASE_URL='<fresh-postgres-16-url>' npm test
POSTGRES_URL='<fresh-postgres-16-url>' npm run db:migrate
POSTGRES_URL='<fresh-postgres-16-url>' npm run ops:preflight
npx tsc --noEmit --incremental false
npm run build
git diff --check
git fsck --full
```

## Dependency on prior batches

None. Start from rejected Phase 6 commit `59be3a4804c33e96ec0e865c52a1f49137cbcfa6` in a clean standalone worktree.

## Expected commit boundary

One commit containing only 0034/0035 ordering, reconciliation-progress migration/schema behavior, preflight contracts, and their tests. Suggested subject: `fix(ops): order phase 6 migrations safely`.
