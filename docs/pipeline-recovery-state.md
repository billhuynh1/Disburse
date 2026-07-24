# Pipeline Recovery State

## Accepted baseline

- Phase 5 commit: `f7007949857d97f878f422af3109224b945c4d73`
- Phase 5 tree: `e2f53f3d53d96dbd1a351cfbc3d3ccf56ba61052`
- Review verdict: accepted with no findings

## Rejected Phase 6 candidate

- Commit: `59be3a4804c33e96ec0e865c52a1f49137cbcfa6`
- Tree: `721d4a37fdb62526cc7811f0a427da10b85d6549`
- Parent: accepted Phase 5 commit
- Review verdict: rejected with seven findings

## Current remediation location

- Worktree: `/private/tmp/disburse-r6-reconstruction`
- Branch: `codex/r6-reconstruction`
- Committed HEAD: rejected Phase 6 candidate `59be3a4`
- State: dirty with pre-existing, unreviewed remediation edits spanning multiple batches
- Rule: existing edits are not an accepted batch boundary and must not be committed together

## Batch status

| Order | Batch | Status | Contract |
|---|---|---|---|
| 1 | A — migrations | Remaining; not independently accepted | `docs/pipeline-recovery/phase6-a-migrations.md` |
| 2 | B — signals | Blocked on accepted A | `docs/pipeline-recovery/phase6-b-signals.md` |
| 3 | C — correlation | Blocked on accepted B | `docs/pipeline-recovery/phase6-c-correlation.md` |
| 4 | D — fault matrix | Blocked on accepted A–C | `docs/pipeline-recovery/phase6-d-fault-matrix.md` |

Completed remediation batches: none. Each batch requires its own implementation commit and independent acceptance before the next begins.

## Non-negotiable regressions

- Preserve accepted R5 authorization, deletion, generation, lease, checkpoint, retry/resume, multi-call external-effect, and stale-worker fences.
- Preserve completed-checkpoint replay with zero provider calls and ambiguous-effect RETRY refusal.
- Preserve recovery request identity isolation, bounded request bodies, malformed-payload safety, and publishing prohibition.
- Preserve Phase 6 redaction, protected snapshots, exact schema contracts, strict Cron thresholds, and heartbeat-independent reconciliation semantics.
- No valid provider credentials, provider calls, existing local services, staging, production, publishing, merge, push, bundle, or E2E.
- Every PostgreSQL gate uses a fresh loopback-only PostgreSQL 16 database and reports zero relevant skips.
- Each accepted batch records commit SHA, tree SHA, parent, exact paths, verification results, and clean status.

## Final Phase 6 review

After A–D are independently accepted, a strongest-model reviewer must inspect the complete accepted-R5-to-final-Phase-6 delta and independently run:

- fresh-database and 0033-upgrade migration verification;
- production-path 5×4 fault verification;
- provider-signal, classification, capacity, correlation, reconciliation, scheduler, recovery, and deletion race suites;
- full database-enabled tests with zero failures and zero relevant skips;
- TypeScript comparison against accepted R5;
- provider-disabled production build and operational preflight;
- `git diff --check` and `git fsck --full`.

Phase 6 is not accepted until that review returns an unqualified `ACCEPT`. Migration-history remediation, durable bundling, bundle restoration, environment reconstruction, and E2E remain blocked until then.
