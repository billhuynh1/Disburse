import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFile, readdir } from 'node:fs/promises';
import { register } from 'node:module';
import { promisify } from 'node:util';
import test from 'node:test';
import postgres from 'postgres';

register('../test/typescript-path-loader.mjs', import.meta.url);
const execFileAsync = promisify(execFile);

test('operational snapshot is schema-verified, correlated, and payload-free', {
  skip: !process.env.PHASE1A_TEST_DATABASE_URL,
}, async () => {
  const configuredUrl = process.env.PHASE1A_TEST_DATABASE_URL!;
  const parsedUrl = new URL(configuredUrl);
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname));
  assert.equal(parsedUrl.pathname.replace(/^\//, ''), 'disburse_phase1a_test');
  const schemaName = `phase6_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(configuredUrl, { max: 2 });
  let appClient: { end: () => Promise<void> } | undefined;
  try {
    await admin.unsafe(`create schema "${schemaName}"`);
    await admin.unsafe(`set search_path to "${schemaName}"`);
    const migrationDirectory = new URL('../db/migrations/', import.meta.url);
    const migrationFiles = (await readdir(migrationDirectory))
      .filter((file) => /^\d+.*\.sql$/.test(file))
      .sort();
    for (const migrationFile of migrationFiles) {
      const migrationSql = await readFile(new URL(migrationFile, migrationDirectory), 'utf8');
      for (const statement of migrationSql.split('--> statement-breakpoint')) {
        const scoped = statement.trim().replaceAll('"public".', `"${schemaName}".`);
        if (scoped) await admin.unsafe(scoped);
      }
    }
    const isolatedUrl = new URL(configuredUrl);
    isolatedUrl.searchParams.set('options', `-csearch_path=${schemaName}`);
    process.env.POSTGRES_URL = isolatedUrl.toString();
    const { client, db } = await import('../db/drizzle.ts');
    appClient = client;
    const schema = await import('../db/schema.ts');
    const invocation = await import('./operational-invocation-service.ts');
    const { getOperationalSnapshot } = await import('./operational-snapshot.ts');
    const { EXPECTED_MIGRATIONS } = await import('../../scripts/operational-schema-contract.mjs');
    const expectedMigrations = EXPECTED_MIGRATIONS;
    const { EXPECTED_JOURNAL_TIMESTAMPS } = await import('../../scripts/operational-schema-contract.mjs');
    await admin.unsafe(`
      create table "${schemaName}".__drizzle_migrations (
        id serial primary key, hash text not null, created_at bigint not null
      )
    `);
    for (const entry of expectedMigrations) {
      const createdAt = EXPECTED_JOURNAL_TIMESTAMPS.get(entry[0]);
      assert.notEqual(createdAt, undefined);
      await admin.unsafe(`insert into "${schemaName}".__drizzle_migrations (hash,created_at) values ('${entry[1]}',${createdAt})`);
    }
    const preflightEnvironment = {
      ...process.env, POSTGRES_URL: isolatedUrl.toString(),
      DISBURSE_MIGRATION_JOURNAL_SCHEMA: schemaName,
    };
    const preflight = await execFileAsync('npm', ['run','ops:preflight','--','--database'], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)), env: preflightEnvironment,
    });
    assert.match(preflight.stdout, /Phase 6 preflight passed/);
    await admin.unsafe(`
      alter table "${schemaName}".operational_signals drop constraint operational_signals_type_check,
      add constraint operational_signals_type_check check (signal_type not in ('internal_trigger_failure', 'provider_failure', 'capacity_blocked', 'unknown_failure'))
    `);
    await assert.rejects(execFileAsync('npm', ['run','ops:preflight','--','--database'], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)), env: preflightEnvironment,
    }), (error) => error instanceof Error && 'stderr' in error &&
      typeof error.stderr === 'string' && error.stderr.includes('operational_signals_type_check'));
    await admin.unsafe(`
      alter table "${schemaName}".operational_signals drop constraint operational_signals_type_check,
      add constraint operational_signals_type_check check (signal_type in ('internal_trigger_failure', 'provider_failure', 'capacity_blocked', 'unknown_failure'))
    `);
    const invocationId = randomUUID();
    await db.insert(schema.jobs).values({
      type: schema.JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL,
      idempotencyKey: 'raw-idempotency-must-not-appear',
      payload: { sourceAssetId: 123, userId: 456 },
    });
    await invocation.startOperationalInvocation({ invocationId, origin: 'internal' });
    await invocation.completeOperationalInvocation({
      invocationId,
      origin: 'internal',
      stopReason: 'queue_empty',
      durationMs: 10,
      processedJobs: 0,
      recoveredJobs: 0,
      reconciledProjects: 0,
      reconciliationCycle: 0,
      followUpTriggered: false,
    });
    for (const [incompatible, reason] of [[false, 'missing'], [true, 'incompatible']] as const) {
      let calls = 0;
      const safe = await getOperationalSnapshot({ execute: async (query) => {
        calls += 1;
        if (!incompatible) return [];
        if (calls === 4) return expectedMigrations.map(entry => ({
          hash: entry[1], created_at: String(EXPECTED_JOURNAL_TIMESTAMPS.get(entry[0])),
        }));
        const rows = await db.execute(query as Parameters<typeof db.execute>[0]);
        if (calls === 1) return rows.map((row) =>
          row.table_name === 'operational_invocations' && row.column_name === 'id'
            ? { ...row, data_type: 'text' }
            : row);
        return rows;
      } });
      assert.equal(safe.schema.verified, false);
      assert.equal(safe.schema.reason, reason);
      assert.equal(safe.queue.depth, 0);
    }
    let calls = 0;
    const snapshot = await getOperationalSnapshot({ execute: async (query) => {
      calls += 1;
      if (calls === 4) return expectedMigrations.map(entry => ({
        hash: entry[1], created_at: String(EXPECTED_JOURNAL_TIMESTAMPS.get(entry[0])),
      }));
      return await db.execute(query as Parameters<typeof db.execute>[0]);
    } });
    assert.equal(snapshot.schema.verified, true);
    assert.equal(calls, 5);
    assert.equal(snapshot.queue.depth, 1);
    const serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(serialized, /raw-idempotency|sourceAssetId|userId|payload/i);
  } finally {
    if (appClient) await appClient.end();
    await admin.unsafe(`drop schema if exists "${schemaName}" cascade`);
    await admin.end();
  }
});
