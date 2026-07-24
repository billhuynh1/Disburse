import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

import {
  EXPECTED_MIGRATIONS,
  validateMigrationJournal,
  validateOperationalCatalog,
} from '../../scripts/operational-schema-contract.mjs';

const configuredUrl = process.env.PHASE1A_TEST_DATABASE_URL;
type SqlClient = {
  unsafe: (query: string) => Promise<Array<Record<string, unknown>>>;
  end: () => Promise<void>;
} & ((strings: TemplateStringsArray, ...values: unknown[]) => unknown);

async function migrationFiles() {
  const migrationDirectory = new URL('../db/migrations/', import.meta.url);
  const journal = JSON.parse(await readFile(new URL('../db/migrations/meta/_journal.json', import.meta.url), 'utf8')) as {
    entries: Array<{ tag: string }>;
  };
  const existingFiles = new Set((await readdir(migrationDirectory))
    .filter((file) => /^\d{4}_.+\.sql$/.test(file)));
  return await Promise.all(journal.entries.map(async ({ tag }) => {
    const file = `${tag}.sql`;
    assert.ok(existingFiles.has(file));
    return {
    file,
    tag: file.replace(/\.sql$/, ''),
    sql: await readFile(new URL(file, migrationDirectory), 'utf8'),
    };
  }));
}

async function applyMigration(client: SqlClient, schemaName: string, migration: { sql: string }) {
  for (const statement of migration.sql.split('--> statement-breakpoint')) {
    const scoped = statement.trim().replaceAll('"public".', `"${schemaName}".`);
    if (scoped) await client.unsafe(scoped);
  }
}

async function recordMigration(client: SqlClient, schemaName: string, tag: string, createdAt: number) {
  const sql = await readFile(new URL(`../db/migrations/${tag}.sql`, import.meta.url), 'utf8');
  const hash = createHash('sha256').update(sql).digest('hex');
  await client.unsafe(
    `insert into "${schemaName}"."__drizzle_migrations" (hash, created_at) values ('${hash}', ${createdAt})`
  );
}

async function assertOperationalCatalog(client: SqlClient, schemaName: string) {
  const columns = await client`
    select ${schemaName} contract_schema, table_name, column_name, data_type, udt_name,
      is_nullable, column_default, character_maximum_length
    from information_schema.columns
    where table_schema=${schemaName}
      and table_name in ('operational_invocations','operational_signals','pipeline_scheduler_state')`;
  const constraints = await client`
    select c.conname,n.nspname schema_name,t.relname table_name,c.contype,c.convalidated,
      pg_get_constraintdef(c.oid, false) definition
    from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace
    where n.nspname=${schemaName}
      and c.conname in ('operational_invocations_origin_check','operational_invocations_status_check','operational_invocations_counts_check','operational_signals_type_check','operational_signals_provider_check','operational_signals_failure_class_check')`;
  const indexes = await client`
    select ci.relname indexname, i.indisunique unique, am.amname method,
      pg_get_expr(i.indpred, i.indrelid, true) predicate,
      array(select pg_get_indexdef(i.indexrelid, key_position, true)
        from generate_series(1, i.indnkeyatts) key_position order by key_position) expressions
    from pg_index i join pg_class ci on ci.oid=i.indexrelid
    join pg_class ct on ct.oid=i.indrelid join pg_am am on am.oid=ci.relam
    where ct.relnamespace=${schemaName}::regnamespace
      and ci.relname in ('operational_invocations_invocation_id_idx','operational_invocations_origin_started_idx','operational_invocations_status_started_idx','operational_signals_type_created_idx')`;
  assert.deepEqual(validateOperationalCatalog({ schemaName, columns, constraints, indexes }), []);
}

test('phase 6 migrations upgrade accepted 0033 through 0034 and 0035 in order', {
  skip: !configuredUrl,
}, async () => {
  const parsedUrl = new URL(configuredUrl!);
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname));
  assert.equal(parsedUrl.pathname.replace(/^\//, ''), 'disburse_phase1a_test');
  const schemaName = `phase6_migration_${randomUUID().replaceAll('-', '')}`;
  const { default: postgres } = await import('postgres');
  const client = postgres(configuredUrl!, { max: 1 });
  try {
    const [{ server_version_num: serverVersion }] = await client`show server_version_num`;
    assert.ok(Number(serverVersion) >= 160000 && Number(serverVersion) < 170000);
    await client.unsafe(`create schema "${schemaName}"`);
    await client.unsafe(`set search_path to "${schemaName}"`);
    await client.unsafe(`create table "${schemaName}"."__drizzle_migrations" (id serial primary key, hash text not null, created_at bigint not null)`);
    const migrations = await migrationFiles();
    for (const [index, migration] of migrations.entries()) {
      if (migration.tag > '0033_durable_job_recovery') break;
      await applyMigration(client, schemaName, migration);
      await recordMigration(client, schemaName, migration.tag, index + 1);
    }
    await client.unsafe(`
      insert into "${schemaName}".pipeline_scheduler_state
        (id, updated_at, owner_token, heartbeat_at, lease_expires_at)
      values (1, timestamp '2024-01-01 00:00:00', 'released-owner',
        timestamp '2024-01-02 00:00:00', timestamp '2024-01-03 00:00:00')
      on conflict (id) do update set updated_at=excluded.updated_at
    `);
    for (const [index, migration] of migrations.entries()) {
      if (migration.tag <= '0033_durable_job_recovery') continue;
      await applyMigration(client, schemaName, migration);
      await recordMigration(client, schemaName, migration.tag, index + 1);
    }
    const rows = await client.unsafe(`
      select hash, created_at from "${schemaName}"."__drizzle_migrations" order by created_at,id
    `);
    assert.deepEqual(validateMigrationJournal(rows.map((row, index) => ({
      tag: (EXPECTED_MIGRATIONS as unknown as Array<readonly [string, string]>)[index]?.[0] ?? null,
      hash: row.hash,
    }))), []);
    assert.deepEqual(rows.slice(-3).map(row => Number(row.created_at)), [32, 33, 34]);
    await assertOperationalCatalog(client, schemaName);
    const [state] = await client.unsafe(`
      select reconciliation_progress_at, reconciliation_progress_count, updated_at, heartbeat_at
      from "${schemaName}".pipeline_scheduler_state where id=1
    `);
    assert.equal(state.reconciliation_progress_at, null);
    assert.equal(Number(state.reconciliation_progress_count), 0);
    assert.notEqual(String(state.updated_at), String(state.heartbeat_at));
  } finally {
    await client.unsafe(`drop schema if exists "${schemaName}" cascade`);
    await client.end();
  }
});

test('phase 6 migrations clean-install through 0035 on an empty PostgreSQL 16 schema', {
  skip: !configuredUrl,
}, async () => {
  const parsedUrl = new URL(configuredUrl!);
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname));
  assert.equal(parsedUrl.pathname.replace(/^\//, ''), 'disburse_phase1a_test');
  const schemaName = `phase6_clean_${randomUUID().replaceAll('-', '')}`;
  const { default: postgres } = await import('postgres');
  const client = postgres(configuredUrl!, { max: 1 });
  try {
    const [{ server_version_num: serverVersion }] = await client`show server_version_num`;
    assert.ok(Number(serverVersion) >= 160000 && Number(serverVersion) < 170000);
    await client.unsafe(`create schema "${schemaName}"`);
    await client.unsafe(`set search_path to "${schemaName}"`);
    await client.unsafe(`create table "${schemaName}"."__drizzle_migrations" (id serial primary key, hash text not null, created_at bigint not null)`);
    const migrations = await migrationFiles();
    for (const [index, migration] of migrations.entries()) {
      await applyMigration(client, schemaName, migration);
      await recordMigration(client, schemaName, migration.tag, index + 1);
    }
    const rows = await client.unsafe(`
      select hash, created_at from "${schemaName}"."__drizzle_migrations" order by created_at,id
    `);
    assert.deepEqual(validateMigrationJournal(rows.map((row, index) => ({
      tag: (EXPECTED_MIGRATIONS as unknown as Array<readonly [string, string]>)[index]?.[0] ?? null,
      hash: row.hash,
    }))), []);
    assert.deepEqual(rows.map(row => Number(row.created_at)), rows.map((_, index) => index + 1));
    await assertOperationalCatalog(client, schemaName);
  } finally {
    await client.unsafe(`drop schema if exists "${schemaName}" cascade`);
    await client.end();
  }
});
