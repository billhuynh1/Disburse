import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import process from 'node:process';
import { EXPECTED_MIGRATIONS, EXPECTED_SCHEMA_VERSION, validateLocalMigrationJournal, validateMigrationFiles, validateMigrationJournal, validateOperationalCatalog, validateSnapshotChain } from './operational-schema-contract.mjs';

const expectedMigration = '0037_short_form_generation_mode.sql';
const migrationDirectory = new URL('../lib/db/migrations/', import.meta.url);
const faultInjectionSource = await readFile(new URL('../lib/disburse/fault-injection.ts', import.meta.url), 'utf8');
const files = (await readdir(migrationDirectory)).filter(f => /^\d{4}_.+\.sql$/.test(f)).sort();
const failures = [];

function readFaultInjectionValues(name) {
  const match = faultInjectionSource.match(new RegExp(`export const ${name} = \\[([^\\]]+)\\] as const;`));
  if (!match) {
    failures.push(`runtime fault injection contract is missing ${name}`);
    return [];
  }
  return [...match[1].matchAll(/'([^']+)'/g)].map(([, value]) => value);
}

const faultInjectionProviders = readFaultInjectionValues('FAULT_INJECTION_PROVIDERS');
const faultInjectionPoints = readFaultInjectionValues('FAULT_INJECTION_POINTS');

function readStrictBoolean(name) {
  const value = process.env[name];
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  failures.push(`${name} must be exactly true or false`);
  return undefined;
}

function hasConfiguredValue(name) {
  return Boolean(process.env[name]?.trim());
}

function validateSecretSeparation(names) {
  for (let leftIndex = 0; leftIndex < names.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < names.length; rightIndex += 1) {
      const left = names[leftIndex];
      const right = names[rightIndex];
      const leftSecret = left === 'DISBURSE_FAULT_INJECTION_SECRET' ? process.env[left] : process.env[left]?.trim();
      const rightSecret = right === 'DISBURSE_FAULT_INJECTION_SECRET' ? process.env[right] : process.env[right]?.trim();
      if (leftSecret && rightSecret && leftSecret === rightSecret) {
        failures.push(`${left} must not reuse ${right}`);
      }
    }
  }
}

function isValidFaultInjection(selection) {
  const [provider, point, extra] = selection.split(':');
  return !extra && faultInjectionProviders.includes(provider) && faultInjectionPoints.includes(point);
}
if (files.at(-1) !== expectedMigration) failures.push(`latest migration must be ${expectedMigration}`);
if (new Set(files).size !== files.length) failures.push('migration filenames must be unique');
const migration = await readFile(new URL(expectedMigration, migrationDirectory), 'utf8');
if (/\b(drop|truncate)\b/i.test(migration)) failures.push('operational migration must be additive');
for (const required of ['short_form_generation_mode']) {
  if (!migration.includes(required)) failures.push(`migration is missing ${required}`);
}
const journal = JSON.parse(await readFile(new URL('../lib/db/migrations/meta/_journal.json', import.meta.url), 'utf8'));
const snapshots = await Promise.all((await readdir(new URL('../lib/db/migrations/meta/', import.meta.url)))
  .filter(file => /^\d{4}_snapshot\.json$/.test(file)).sort().map(async file => ({
    tag: file.slice(0, 4),
    ...JSON.parse(await readFile(new URL(`../lib/db/migrations/meta/${file}`, import.meta.url), 'utf8')),
  })));
const localMigrationRows = await Promise.all(journal.entries.map(async entry => ({
  tag: entry.tag,
  hash: createHash('sha256').update(await readFile(new URL(`${entry.tag}.sql`, migrationDirectory))).digest('hex'),
  created_at: String(entry.when),
})));
failures.push(...validateMigrationJournal(localMigrationRows).map(failure => `local ${failure}`));
failures.push(...validateLocalMigrationJournal(journal.entries));
failures.push(...validateMigrationFiles(journal.entries, new Set(files)));
failures.push(...validateSnapshotChain(snapshots));
if (!files.includes('0036_generation_run_snapshots.sql')) failures.push('Phase-A target migration file is missing');
if (!files.includes('0037_short_form_generation_mode.sql')) failures.push('Phase-B generation mode migration file is missing');
const metadata = snapshots.find(snapshot => snapshot.tag === '0036');
if (!metadata?.tables?.['public.generation_runs']) failures.push('0036 Drizzle metadata is incompatible with schema history');
const modeMetadata = snapshots.find(snapshot => snapshot.tag === '0037');
if (!modeMetadata?.tables?.['public.content_packs']?.columns?.short_form_generation_mode) failures.push('0037 Drizzle metadata is incompatible with schema history');

if (process.argv.includes('--require-env')) {
  for (const name of ['POSTGRES_URL','INTERNAL_PROCESSING_SECRET','CRON_SECRET','OPERATIONAL_SNAPSHOT_SECRET','OPENAI_API_KEY','MEDIA_API_SECRET','S3_UPLOAD_ACCESS_KEY_ID','S3_UPLOAD_SECRET_ACCESS_KEY']) {
    if (!hasConfiguredValue(name)) failures.push(`${name} is not configured`);
  }
  const deploymentEnvironment = process.env.DISBURSE_DEPLOYMENT_ENV;
  const validDeploymentEnvironments = ['production', 'staging', 'development', 'test'];
  if (!validDeploymentEnvironments.includes(deploymentEnvironment)) {
    failures.push('DISBURSE_DEPLOYMENT_ENV must be one of production, staging, development, or test');
  }

  const cronExpected = readStrictBoolean('DISBURSE_CRON_EXPECTED');
  const faultsEnabled = readStrictBoolean('DISBURSE_STAGING_FAULT_INJECTION_ENABLED');
  const faultSelection = process.env.DISBURSE_FAULT_INJECTION || null;
  const protectedSecrets = ['INTERNAL_PROCESSING_SECRET', 'CRON_SECRET', 'OPERATIONAL_SNAPSHOT_SECRET'];
  validateSecretSeparation(protectedSecrets);

  if (deploymentEnvironment === 'production') {
    if (cronExpected === false) failures.push('DISBURSE_CRON_EXPECTED must be true or unset for production');
    if (faultsEnabled === true) failures.push('DISBURSE_STAGING_FAULT_INJECTION_ENABLED must be false or unset for production');
    if (faultSelection) failures.push('DISBURSE_FAULT_INJECTION must be empty or unset for production');
  }

  if (deploymentEnvironment === 'staging') {
    if (faultsEnabled === true) {
      if (!hasConfiguredValue('DISBURSE_FAULT_INJECTION_SECRET')) failures.push('DISBURSE_FAULT_INJECTION_SECRET is not configured');
      else validateSecretSeparation([...protectedSecrets, 'DISBURSE_FAULT_INJECTION_SECRET']);
      if (!faultSelection) failures.push('DISBURSE_FAULT_INJECTION is required when staging fault injection is enabled');
      else if (!isValidFaultInjection(faultSelection)) failures.push('DISBURSE_FAULT_INJECTION must select a valid provider and point');
    } else if ((faultsEnabled === false || process.env.DISBURSE_STAGING_FAULT_INJECTION_ENABLED === undefined) && faultSelection) {
      failures.push('DISBURSE_FAULT_INJECTION must be empty or unset when staging fault injection is disabled');
    }
  }
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
      const journalColumn = await client.unsafe(`select data_type, udt_name from information_schema.columns where table_schema = '${journalSchema}' and table_name = '__drizzle_migrations' and column_name = 'created_at'`)
        .catch(() => { throw new Error('Migration journal table is unavailable.'); });
      if (journalColumn.length !== 1 || journalColumn[0].data_type !== 'bigint' || journalColumn[0].udt_name !== 'int8') {
        failures.push('database migration journal created_at column type drift: expected bigint');
      }
      const migrationRows = await client.unsafe(`select hash, created_at::text created_at from "${journalSchema}"."__drizzle_migrations" order by created_at,id`)
        .catch(() => { throw new Error('Migration journal table is unavailable.'); });
      failures.push(...validateMigrationJournal(migrationRows.map((row, index) => ({
        tag: EXPECTED_MIGRATIONS[index]?.[0] ?? null,
        hash: row.hash,
        created_at: row.created_at,
      }))));
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
  process.stdout.write(`Phase 6 preflight passed: schema=${EXPECTED_SCHEMA_VERSION} journal_entries=${journal.entries.length} migration_sha256=${fingerprint}\n`);
}
