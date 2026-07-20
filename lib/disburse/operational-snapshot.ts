import 'server-only';

import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { isOperationalCronExpected } from '@/lib/disburse/operational-environment';
import { EXPECTED_MIGRATIONS, validateMigrationJournal, validateOperationalCatalog } from '../../scripts/operational-schema-contract.mjs';

export const OPERATIONAL_SCHEMA_VERSION = 35;

export type OperationalSnapshot = {
  generatedAt: string;
  schema: { expectedVersion: number; verified: boolean; reason: 'verified' | 'missing' | 'incompatible' };
  queue: { depth: number; oldestAgeSeconds: number };
  scheduler: { cronExpected: boolean; heartbeatAgeSeconds: number | null; leaseExpired: boolean; processorOwned: boolean; lastCronAgeSeconds: number | null; lastCronFailed: boolean; repeatedCronFailures: number; internalTriggerFailures15m: number };
  leases: { expired: number; processing: number };
  reconciliation: { cursor: number | null; cycle: number; progressAgeSeconds: number | null; progressCount: number };
  checkpoints: { prepared: number; ambiguous: number };
  deletion: { backlog: number; oldestAgeSeconds: number };
  recovery: { accepted24h: number; rejected24h: number; budgetExhausted: number };
  lineage: { budgetExhausted: number };
  capacity: { renderActive: number; facecamActive: number; renderLimit: number; facecamLimit: number; blocked: boolean; blockedSignals15m: number };
  locks: { schedulerHeld: boolean; expiredOwnerPresent: boolean };
  audit: { rows24h: number; previous24h: number; growth: number };
  providers: { failures15m: number; byProvider: Record<'openai' | 's3' | 'media' | 'render' | 'facecam', number> };
  failures: { unknown15m: number };
};

type Executor = { execute(query: unknown): Promise<readonly Record<string, unknown>[]> };
const PROVIDERS = ['openai', 's3', 'media', 'render', 'facecam'] as const;

function integer(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}
function nullableInteger(value: unknown) {
  return value === null || value === undefined ? null : integer(value);
}

function emptySnapshot(reason: 'missing' | 'incompatible'): OperationalSnapshot {
  const renderLimit = Math.max(1, integer(process.env.MAX_RENDER_CONCURRENCY || 1));
  const facecamLimit = Math.max(1, integer(process.env.MAX_FACECAM_CONCURRENCY || 1));
  return {
    generatedAt: new Date().toISOString(), schema: { expectedVersion: 35, verified: false, reason },
    queue: { depth: 0, oldestAgeSeconds: 0 },
    scheduler: { cronExpected: isOperationalCronExpected(), heartbeatAgeSeconds: null, leaseExpired: false, processorOwned: false, lastCronAgeSeconds: null, lastCronFailed: false, repeatedCronFailures: 0, internalTriggerFailures15m: 0 },
    leases: { expired: 0, processing: 0 },
    reconciliation: { cursor: null, cycle: 0, progressAgeSeconds: null, progressCount: 0 },
    checkpoints: { prepared: 0, ambiguous: 0 }, deletion: { backlog: 0, oldestAgeSeconds: 0 },
    recovery: { accepted24h: 0, rejected24h: 0, budgetExhausted: 0 }, lineage: { budgetExhausted: 0 },
    capacity: { renderActive: 0, facecamActive: 0, renderLimit, facecamLimit, blocked: false, blockedSignals15m: 0 },
    locks: { schedulerHeld: false, expiredOwnerPresent: false }, audit: { rows24h: 0, previous24h: 0, growth: 0 },
    providers: { failures15m: 0, byProvider: { openai: 0, s3: 0, media: 0, render: 0, facecam: 0 } }, failures: { unknown15m: 0 },
  };
}

export async function verifyOperationalSchema(executor: Executor = db): Promise<{ verified: boolean; reason: 'verified' | 'missing' | 'incompatible' }> {
  try {
    const columns = await executor.execute(sql<Record<string, unknown>>`
      select current_schema() contract_schema,table_name,column_name,data_type,udt_name,is_nullable,column_default,character_maximum_length
      from information_schema.columns where table_schema=current_schema()
        and table_name in ('operational_invocations','operational_signals','pipeline_scheduler_state')`);
    if (columns.length === 0) return { verified: false, reason: 'missing' };
    const constraints = await executor.execute(sql<Record<string, unknown>>`
      select c.conname,n.nspname schema_name,t.relname table_name,c.contype,c.convalidated,
        pg_get_constraintdef(c.oid, false) definition
      from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace
      where n.nspname=current_schema()
        and c.conname in ('operational_invocations_origin_check','operational_invocations_status_check','operational_invocations_counts_check','operational_signals_type_check','operational_signals_provider_check','operational_signals_failure_class_check')`);
    const indexes = await executor.execute(sql<Record<string, unknown>>`
      select ci.relname indexname, i.indisunique unique, am.amname method,
        pg_get_expr(i.indpred, i.indrelid, true) predicate,
        array(select pg_get_indexdef(i.indexrelid, key_position, true)
          from generate_series(1, i.indnkeyatts) key_position order by key_position) expressions
      from pg_index i join pg_class ci on ci.oid=i.indexrelid
      join pg_class ct on ct.oid=i.indrelid join pg_am am on am.oid=ci.relam
      where ct.relnamespace=current_schema()::regnamespace
        and ci.relname in ('operational_invocations_invocation_id_idx','operational_invocations_origin_started_idx','operational_invocations_status_started_idx','operational_signals_type_created_idx')`);
    const migrationRows = await executor.execute(sql<Record<string, unknown>>`
      select hash from drizzle.__drizzle_migrations order by created_at,id`);
    const catalogFailures = validateOperationalCatalog({ schemaName: columns[0]?.contract_schema, columns, constraints, indexes });
    const journalFailures = validateMigrationJournal(migrationRows.map((row: Record<string, unknown>, index: number) => ({
      tag: EXPECTED_MIGRATIONS[index]?.[0] ?? null, hash: row.hash,
    })));
    return catalogFailures.length === 0 && journalFailures.length === 0
      ? { verified: true, reason: 'verified' }
      : { verified: false, reason: 'incompatible' };
  } catch {
    return { verified: false, reason: 'missing' };
  }
}

export async function getOperationalSnapshot(executor: Executor = db): Promise<OperationalSnapshot> {
  const schema = await verifyOperationalSchema(executor);
  if (!schema.verified) return emptySnapshot(schema.reason === 'missing' ? 'missing' : 'incompatible');
  const rows = await executor.execute(sql<Record<string, unknown>>`
    select
      (select count(*)::int from jobs where status = 'pending' and available_at <= clock_timestamp()) queue_depth,
      (select coalesce(extract(epoch from clock_timestamp() - min(available_at)),0)::int from jobs where status = 'pending' and available_at <= clock_timestamp()) queue_age,
      (select extract(epoch from clock_timestamp() - heartbeat_at)::int from pipeline_scheduler_state where id=1) heartbeat_age,
      (select coalesce(lease_expires_at <= clock_timestamp(),false) from pipeline_scheduler_state where id=1) lease_expired,
      (select coalesce(owner_token is not null and lease_expires_at > clock_timestamp(),false) from pipeline_scheduler_state where id=1) processor_owned,
      (select extract(epoch from clock_timestamp() - max(started_at))::int from operational_invocations where origin='cron') cron_age,
      coalesce((select status='failed' from operational_invocations where origin='cron' order by started_at desc limit 1),false) cron_failed,
      (select count(*)::int from (select status from operational_invocations where origin='cron' order by started_at desc limit 3) c where status='failed') repeated_cron_failures,
      (select count(*)::int from operational_signals where signal_type='internal_trigger_failure' and created_at >= clock_timestamp()-interval '15 minutes') trigger_failures,
      (select count(*)::int from jobs where status='processing' and lease_expires_at <= clock_timestamp()) expired_leases,
      (select count(*)::int from jobs where status='processing') processing_jobs,
      (select reconciliation_cursor from pipeline_scheduler_state where id=1) reconciliation_cursor,
      coalesce((select reconciliation_cycle from pipeline_scheduler_state where id=1),0) reconciliation_cycle,
      (select extract(epoch from clock_timestamp()-reconciliation_progress_at)::int from pipeline_scheduler_state where id=1) reconciliation_age,
      coalesce((select reconciliation_progress_count from pipeline_scheduler_state where id=1),0) reconciliation_count,
      (select count(*)::int from job_effect_checkpoints where status='prepared') prepared_checkpoints,
      (select count(*)::int from job_effect_checkpoints where status='ambiguous') ambiguous_checkpoints,
      ((select count(*) from projects where deletion_requested_at is not null)+(select count(*) from source_assets where deletion_requested_at is not null and (deleted_at is null or (storage_key is not null and storage_deleted_at is null))))::int deletion_backlog,
      coalesce((select extract(epoch from clock_timestamp()-min(requested_at))::int from (select deletion_requested_at requested_at from projects where deletion_requested_at is not null union all select deletion_requested_at from source_assets where deletion_requested_at is not null and (deleted_at is null or (storage_key is not null and storage_deleted_at is null))) d),0) deletion_age,
      (select count(*)::int from job_recovery_requests where outcome='accepted' and created_at>=clock_timestamp()-interval '24 hours') recovery_accepted,
      (select count(*)::int from job_recovery_requests where outcome='rejected' and created_at>=clock_timestamp()-interval '24 hours') recovery_rejected,
      (select count(*)::int from job_recovery_requests where outcome_code='recovery_budget_exhausted' and created_at>=clock_timestamp()-interval '24 hours') recovery_budget,
      (select count(*)::int from jobs where status='failed' and recovery_attempt>=3) lineage_budget,
      (select count(*)::int from jobs where status='processing' and type in ('render_clip_candidate','format_rendered_clip_short_form')) render_active,
      (select count(*)::int from jobs where status='processing' and type='detect_clip_facecam') facecam_active,
      (select count(*)::int from operational_signals where signal_type='capacity_blocked' and created_at>=clock_timestamp()-interval '15 minutes') capacity_signals,
      (select coalesce(owner_token is not null,false) from pipeline_scheduler_state where id=1) owner_present,
      (select coalesce(owner_token is not null and lease_expires_at<=clock_timestamp(),false) from pipeline_scheduler_state where id=1) expired_owner,
      ((select count(*) from operational_invocations where created_at>=clock_timestamp()-interval '24 hours')+(select count(*) from job_recovery_events where created_at>=clock_timestamp()-interval '24 hours')+(select count(*) from activity_logs where timestamp>=clock_timestamp()-interval '24 hours'))::int audit_24h,
      ((select count(*) from operational_invocations where created_at>=clock_timestamp()-interval '48 hours' and created_at<clock_timestamp()-interval '24 hours')+(select count(*) from job_recovery_events where created_at>=clock_timestamp()-interval '48 hours' and created_at<clock_timestamp()-interval '24 hours')+(select count(*) from activity_logs where timestamp>=clock_timestamp()-interval '48 hours' and timestamp<clock_timestamp()-interval '24 hours'))::int audit_previous,
      (select count(*)::int from operational_signals where signal_type='provider_failure' and created_at>=clock_timestamp()-interval '15 minutes') provider_failures,
      (select count(*)::int from operational_signals where signal_type='unknown_failure' and created_at>=clock_timestamp()-interval '15 minutes') unknown_failures,
      (select coalesce(jsonb_object_agg(provider,n), '{}'::jsonb) from (select provider,count(*)::int n from operational_signals where signal_type='provider_failure' and created_at>=clock_timestamp()-interval '15 minutes' group by provider) p) provider_counts
  `).catch(() => []);
  if (!rows[0]) return emptySnapshot('incompatible');
  const r = rows[0] ?? {};
  const renderLimit = Math.max(1, integer(process.env.MAX_RENDER_CONCURRENCY || 1));
  const facecamLimit = Math.max(1, integer(process.env.MAX_FACECAM_CONCURRENCY || 1));
  const renderActive = integer(r.render_active), facecamActive = integer(r.facecam_active);
  const providerCounts = (r.provider_counts && typeof r.provider_counts === 'object' ? r.provider_counts : {}) as Record<string, unknown>;
  const byProvider = Object.fromEntries(PROVIDERS.map(p => [p, integer(providerCounts[p])])) as OperationalSnapshot['providers']['byProvider'];
  const rows24h = integer(r.audit_24h), previous24h = integer(r.audit_previous);
  return {
    generatedAt: new Date().toISOString(), schema: { expectedVersion: 35, verified: true, reason: 'verified' },
    queue: { depth: integer(r.queue_depth), oldestAgeSeconds: integer(r.queue_age) },
    scheduler: { cronExpected: isOperationalCronExpected(), heartbeatAgeSeconds: nullableInteger(r.heartbeat_age), leaseExpired: r.lease_expired===true, processorOwned: r.processor_owned===true, lastCronAgeSeconds: nullableInteger(r.cron_age), lastCronFailed: r.cron_failed===true, repeatedCronFailures: integer(r.repeated_cron_failures), internalTriggerFailures15m: integer(r.trigger_failures) },
    leases: { expired: integer(r.expired_leases), processing: integer(r.processing_jobs) },
    reconciliation: { cursor: nullableInteger(r.reconciliation_cursor), cycle: integer(r.reconciliation_cycle), progressAgeSeconds: nullableInteger(r.reconciliation_age), progressCount: integer(r.reconciliation_count) },
    checkpoints: { prepared: integer(r.prepared_checkpoints), ambiguous: integer(r.ambiguous_checkpoints) }, deletion: { backlog: integer(r.deletion_backlog), oldestAgeSeconds: integer(r.deletion_age) },
    recovery: { accepted24h: integer(r.recovery_accepted), rejected24h: integer(r.recovery_rejected), budgetExhausted: integer(r.recovery_budget) }, lineage: { budgetExhausted: integer(r.lineage_budget) },
    capacity: { renderActive, facecamActive, renderLimit, facecamLimit, blocked: renderActive>=renderLimit || facecamActive>=facecamLimit, blockedSignals15m: integer(r.capacity_signals) },
    locks: { schedulerHeld: r.owner_present===true, expiredOwnerPresent: r.expired_owner===true }, audit: { rows24h, previous24h, growth: rows24h-previous24h },
    providers: { failures15m: integer(r.provider_failures), byProvider }, failures: { unknown15m: integer(r.unknown_failures) },
  };
}
