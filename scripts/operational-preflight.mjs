import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import process from 'node:process';
import { EXPECTED_MIGRATIONS, validateLocalMigrationJournal, validateMigrationJournal, validateOperationalCatalog } from './operational-schema-contract.mjs';

const expectedMigration = '0035_operational_verification_remediation.sql';
const migrationDirectory = new URL('../lib/db/migrations/', import.meta.url);
const files = (await readdir(migrationDirectory)).filter(f => /^\d{4}_.+\.sql$/.test(f)).sort();
const failures = [];
if (files.at(-1) !== expectedMigration) failures.push(`latest migration must be ${expectedMigration}`);
if (new Set(files).size !== files.length) failures.push('migration filenames must be unique');
const migration = await readFile(new URL(expectedMigration, migrationDirectory), 'utf8');
if (/\b(drop|truncate)\b/i.test(migration)) failures.push('operational migration must be additive');
for (const required of ['reconciliation_progress_at', 'reconciliation_progress_count', 'operational_signals']) {
  if (!migration.includes(required)) failures.push(`migration is missing ${required}`);
}
const journal = JSON.parse(await readFile(new URL('../lib/db/migrations/meta/_journal.json', import.meta.url), 'utf8'));
const localMigrationRows = await Promise.all(journal.entries.map(async entry => ({
  tag: entry.tag,
  hash: createHash('sha256').update(await readFile(new URL(`${entry.tag}.sql`, migrationDirectory))).digest('hex'),
})));
failures.push(...validateMigrationJournal(localMigrationRows).map(failure => `local ${failure}`));
failures.push(...validateLocalMigrationJournal(journal.entries));
if (!files.includes('0035_operational_verification_remediation.sql')) failures.push('Phase-6 target migration file is missing');
const metadata = JSON.parse(await readFile(new URL('../lib/db/migrations/meta/0035_snapshot.json', import.meta.url), 'utf8'));
const priorMetadata = JSON.parse(await readFile(new URL('../lib/db/migrations/meta/0034_snapshot.json', import.meta.url), 'utf8'));
if (metadata.prevId !== priorMetadata.id || metadata.version !== '7' || metadata.dialect !== 'postgresql' || !metadata.tables?.['public.operational_signals']) failures.push('0035 Drizzle metadata is incompatible with schema history');
const lateSnapshots = new Map();
for (const tag of ['0033_durable_job_recovery', '0034_operational_verification', '0035_operational_verification_remediation']) {
  lateSnapshots.set(tag, JSON.parse(await readFile(new URL(`../lib/db/migrations/meta/${tag.slice(0, 4)}_snapshot.json`, import.meta.url), 'utf8')));
}
for (const [previousTag, nextTag] of [
  ['0033_durable_job_recovery', '0034_operational_verification'],
  ['0034_operational_verification', '0035_operational_verification_remediation'],
]) {
  if (lateSnapshots.get(nextTag).prevId !== lateSnapshots.get(previousTag).id) {
    failures.push(`snapshot prevId chain is broken at ${nextTag}`);
  }
}

if (process.argv.includes('--require-env')) {
  for (const name of ['POSTGRES_URL','INTERNAL_PROCESSING_SECRET','CRON_SECRET','OPERATIONAL_SNAPSHOT_SECRET','OPENAI_API_KEY','MEDIA_API_SECRET','S3_UPLOAD_ACCESS_KEY_ID','S3_UPLOAD_SECRET_ACCESS_KEY']) {
    if (!process.env[name]?.trim()) failures.push(`${name} is not configured`);
  }
  const faultsEnabled = process.env.DISBURSE_STAGING_FAULT_INJECTION_ENABLED === 'true';
  if (faultsEnabled && process.env.DISBURSE_DEPLOYMENT_ENV !== 'staging') failures.push('fault injection requires explicit staging deployment identity');
  if (faultsEnabled && !process.env.DISBURSE_FAULT_INJECTION_SECRET?.trim()) failures.push('fault injection authorization secret is not configured');
}

if (process.argv.includes('--database')) {
  const { default: postgres } = await import('postgres');
  if (!process.env.POSTGRES_URL) failures.push('POSTGRES_URL is required for --database');
  else {
    const client = postgres(process.env.POSTGRES_URL, { max: 1, idle_timeout: 2 });
    try {
      const columns = await client`select current_schema() contract_schema,table_name,column_name,data_type,udt_name,is_nullable,column_default,character_maximum_length from information_schema.columns where table_schema=current_schema() and table_name in ('operational_invocations','operational_signals','pipeline_scheduler_state')`;
      const constraints = await client`
        select c.conname,n.nspname schema_name,t.relname table_name,c.contype,c.convalidated,
          pg_get_constraintdef(c.oid, false) definition
        from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace
        where n.nspname=current_schema()
          and c.conname in ('operational_invocations_origin_check','operational_invocations_status_check','operational_invocations_counts_check','operational_signals_type_check','operational_signals_provider_check','operational_signals_failure_class_check')`;
      const indexes = await client`
        select ci.relname indexname, i.indisunique unique, am.amname method,
          pg_get_expr(i.indpred, i.indrelid, true) predicate,
          array(select pg_get_indexdef(i.indexrelid, key_position, true)
            from generate_series(1, i.indnkeyatts) key_position order by key_position) expressions
        from pg_index i join pg_class ci on ci.oid=i.indexrelid
        join pg_class ct on ct.oid=i.indrelid join pg_am am on am.oid=ci.relam
        where ct.relnamespace=current_schema()::regnamespace
          and ci.relname in ('operational_invocations_invocation_id_idx','operational_invocations_origin_started_idx','operational_invocations_status_started_idx','operational_signals_type_created_idx')`;
      failures.push(...validateOperationalCatalog({ schemaName: columns[0]?.contract_schema, columns, constraints, indexes }));
      const journalSchema = process.env.DISBURSE_MIGRATION_JOURNAL_SCHEMA || 'drizzle';
      if (!/^[a-z][a-z0-9_]{0,62}$/.test(journalSchema)) throw new Error('Migration journal schema name is invalid.');
      const migrationRows = await client.unsafe(`select hash from "${journalSchema}"."__drizzle_migrations" order by created_at,id`).catch(() => []);
      failures.push(...validateMigrationJournal(migrationRows.map((row, index) => ({ tag: EXPECTED_MIGRATIONS[index]?.[0] ?? null, hash: row.hash }))));
      const forbidden = columns.filter(c => ['operational_invocations','operational_signals'].includes(c.table_name) && /payload|transcript|response|secret|url|idempotency/i.test(c.column_name));
      if (forbidden.length) failures.push('operational tables contain a forbidden data column');
    } finally { await client.end(); }
  }
}

if (failures.length) {
  for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
  process.exitCode = 1;
} else {
  const fingerprint = createHash('sha256').update(migration).digest('hex').slice(0, 12);
  process.stdout.write(`Phase 6 preflight passed: schema=35 journal_entries=${journal.entries.length} migration_sha256=${fingerprint}\n`);
}
