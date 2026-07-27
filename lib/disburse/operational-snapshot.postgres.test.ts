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
    const { getOperationalSnapshot, verifyOperationalSchema } = await import('./operational-snapshot.ts');
    const { EXPECTED_MIGRATIONS } = await import('../../scripts/operational-schema-contract.mjs');
    const expectedMigrations = EXPECTED_MIGRATIONS;
    const { EXPECTED_JOURNAL_TIMESTAMPS } = await import('../../scripts/operational-schema-contract.mjs');
    await admin.unsafe(`
      create table "${schemaName}".__drizzle_migrations (
        id serial primary key, hash text not null, created_at bigint not null
      )
    `);
    await admin.unsafe(`
      create schema drizzle;
      create table drizzle.__drizzle_migrations (
        id serial primary key, hash text not null, created_at bigint not null
      )
    `);
    for (const entry of expectedMigrations) {
      const createdAt = EXPECTED_JOURNAL_TIMESTAMPS.get(entry[0]);
      assert.notEqual(createdAt, undefined);
      await admin.unsafe(`insert into "${schemaName}".__drizzle_migrations (hash,created_at) values ('${entry[1]}',${createdAt})`);
      await admin.unsafe(`insert into drizzle.__drizzle_migrations (hash,created_at) values ('${entry[1]}',${createdAt})`);
    }
    assert.deepEqual(await verifyOperationalSchema(db), { verified: true, reason: 'verified' });
    await admin.unsafe(`
      alter table drizzle.__drizzle_migrations
      alter column created_at type numeric using created_at::numeric
    `);
    assert.deepEqual(await verifyOperationalSchema(db), { verified: false, reason: 'incompatible' });
    await admin.unsafe(`
      alter table drizzle.__drizzle_migrations
      alter column created_at type bigint using created_at::bigint
    `);
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
          hash: entry[1], created_at: String(EXPECTED_JOURNAL_TIMESTAMPS.get(entry[0])), created_at_type: 'bigint',
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
        hash: entry[1], created_at: String(EXPECTED_JOURNAL_TIMESTAMPS.get(entry[0])), created_at_type: 'bigint',
      }));
      return await db.execute(query as Parameters<typeof db.execute>[0]);
    } });
    assert.equal(snapshot.schema.verified, true);
    assert.equal(calls, 5);
    assert.equal(snapshot.queue.depth, 1);
    const serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(serialized, /raw-idempotency|sourceAssetId|userId|payload/i);

    await admin.unsafe(`
      update jobs set available_at=clock_timestamp()+interval '1 day';
      insert into jobs (type,status,payload,idempotency_key,attempt_count,max_attempts,available_at,cancellation_requested_at,lease_expires_at) values
        ('extract_source_asset_thumbnail','pending','{}','operational-eligible',0,3,clock_timestamp()-interval '20 minutes',null,null),
        ('extract_source_asset_thumbnail','pending','{}','operational-cancelled',0,3,clock_timestamp()-interval '30 minutes',clock_timestamp(),null),
        ('extract_source_asset_thumbnail','pending','{}','operational-exhausted',3,3,clock_timestamp()-interval '30 minutes',null,null),
        ('extract_source_asset_thumbnail','processing','{}','operational-null-lease',0,3,clock_timestamp(),null,null),
        ('render_clip_candidate','processing','{}','operational-render-valid',0,3,clock_timestamp(),null,clock_timestamp()+interval '1 hour'),
        ('format_rendered_clip_short_form','processing','{}','operational-render-expired',0,3,clock_timestamp(),null,clock_timestamp()-interval '1 minute'),
        ('detect_clip_facecam','processing','{}','operational-facecam-null',0,3,clock_timestamp(),null,null);
      update pipeline_scheduler_state
        set owner_token='expired-owner', lease_expires_at=null, heartbeat_at=clock_timestamp()-interval '10 minutes'
        where id=1;
      insert into job_effect_checkpoints (job_id,effect_key,job_type,status)
        select id,'operational-ambiguous','extract_source_asset_thumbnail','external_effect_started'
        from jobs where idempotency_key='operational-eligible';
      insert into job_recovery_requests (idempotency_identity,request_fingerprint,outcome,outcome_code)
        values ('operational-recovery-budget','operational-recovery-budget','rejected','lineage_attempts_exhausted');
      insert into operational_signals (signal_type,provider,created_at) values
        ('internal_trigger_failure',null,clock_timestamp()-interval '5 minutes'),
        ('internal_trigger_failure',null,clock_timestamp()-interval '16 minutes'),
        ('capacity_blocked',null,clock_timestamp()-interval '5 minutes'),
        ('capacity_blocked',null,clock_timestamp()-interval '5 minutes'),
        ('capacity_blocked',null,clock_timestamp()-interval '5 minutes'),
        ('capacity_blocked',null,clock_timestamp()-interval '16 minutes'),
        ('unknown_failure',null,clock_timestamp()-interval '5 minutes'),
        ('unknown_failure',null,clock_timestamp()-interval '16 minutes'),
        ('internal_trigger_failure','media',clock_timestamp()-interval '5 minutes'),
        ('provider_failure','openai',clock_timestamp()-interval '5 minutes'),
        ('provider_failure','openai',clock_timestamp()-interval '5 minutes'),
        ('provider_failure','openai',clock_timestamp()-interval '5 minutes'),
        ('provider_failure','openai',clock_timestamp()-interval '5 minutes'),
        ('provider_failure','openai',clock_timestamp()-interval '5 minutes'),
        ('provider_failure',null,clock_timestamp()-interval '5 minutes'),
        ('provider_failure','s3',clock_timestamp()-interval '16 minutes');
    `);
    const runtimeSnapshot = await getOperationalSnapshot(db);
    assert.equal(runtimeSnapshot.queue.depth, 1);
    assert.ok(runtimeSnapshot.queue.oldestAgeSeconds >= 1_200);
    assert.ok(runtimeSnapshot.queue.oldestAgeSeconds < 1_500);
    assert.equal(runtimeSnapshot.scheduler.leaseExpired, true);
    assert.equal(runtimeSnapshot.locks.expiredOwnerPresent, true);
    await admin.unsafe(`update pipeline_scheduler_state set lease_expires_at=clock_timestamp()-interval '1 minute' where id=1`);
    const expiredSchedulerSnapshot = await getOperationalSnapshot(db);
    assert.equal(expiredSchedulerSnapshot.scheduler.leaseExpired, true);
    assert.equal(expiredSchedulerSnapshot.locks.expiredOwnerPresent, true);
    await admin.unsafe(`update pipeline_scheduler_state set lease_expires_at=null where id=1`);
    assert.equal(runtimeSnapshot.leases.processing, 4);
    assert.equal(runtimeSnapshot.leases.expired, 3);
    assert.equal(runtimeSnapshot.capacity.renderActive, 2);
    assert.equal(runtimeSnapshot.capacity.facecamActive, 1);
    assert.equal(runtimeSnapshot.checkpoints.ambiguous, 1);
    assert.equal(runtimeSnapshot.recovery.budgetExhausted, 1);
    assert.equal(runtimeSnapshot.scheduler.internalTriggerFailures15m, 2);
    assert.equal(runtimeSnapshot.capacity.blockedSignals15m, 3);
    assert.equal(runtimeSnapshot.failures.unknown15m, 1);
    assert.equal(runtimeSnapshot.providers.failures15m, 5);
    assert.deepEqual(runtimeSnapshot.providers.byProvider, { openai: 5, s3: 0, media: 0, render: 0, facecam: 0 });
    const { checkOperationalAlerts } = await import('./operational-alerts.ts');
    assert.ok(checkOperationalAlerts(runtimeSnapshot).some((alert) => alert.id === 'scheduler_stall'));
    assert.ok(checkOperationalAlerts(runtimeSnapshot).some((alert) => alert.id === 'queue_backlog'));
    assert.ok(checkOperationalAlerts(runtimeSnapshot).some((alert) => alert.id === 'ambiguous_effects'));
    assert.ok(checkOperationalAlerts(runtimeSnapshot).some((alert) => alert.id === 'recovery_budget_exhaustion'));
    assert.ok(checkOperationalAlerts(runtimeSnapshot).some((alert) => alert.id === 'provider_outage'));

    const { GET } = await import('../../app/api/internal/operations/snapshot/route.ts');
    const originalSecret = process.env.OPERATIONAL_SNAPSHOT_SECRET;
    delete process.env.OPERATIONAL_SNAPSHOT_SECRET;
    const missingSecret = await GET(new Request('http://localhost/api/internal/operations/snapshot', { headers: { authorization: 'Bearer operational-secret' } }));
    assert.equal(missingSecret.status, 404);
    assert.equal(missingSecret.headers.get('Cache-Control'), 'no-store');
    process.env.OPERATIONAL_SNAPSHOT_SECRET = 'operational-secret';
    for (const authorization of [null, 'Basic operational-secret', 'Bearer ', 'Bearer wrong-secret']) {
      const response = await GET(new Request('http://localhost/api/internal/operations/snapshot', {
        headers: authorization === null ? {} : { authorization },
      }));
      assert.equal(response.status, 404);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
    const authorized = await GET(new Request('http://localhost/api/internal/operations/snapshot', { headers: { authorization: 'Bearer operational-secret' } }));
    assert.equal(authorized.status, 200);
    assert.equal(authorized.headers.get('Cache-Control'), 'no-store');
    const authorizedBody = await authorized.json() as { snapshot: typeof runtimeSnapshot; alerts: Array<{ id: string }> };
    assert.equal(authorizedBody.snapshot.schema.verified, true);
    assert.equal(authorizedBody.snapshot.queue.depth, 1);
    assert.ok(authorizedBody.alerts.some((alert) => alert.id === 'provider_outage'));
    assert.doesNotMatch(JSON.stringify(authorizedBody), /raw-idempotency|sourceAssetId|userId|payload|secret|token|credential|stack|provider body/i);

    await admin.unsafe(`
      alter table "${schemaName}".operational_signals drop constraint operational_signals_type_check,
      add constraint operational_signals_type_check check ((signal_type in ('internal_trigger_failure', 'provider_failure', 'capacity_blocked', 'unknown_failure')) and signal_type is not null)
    `);
    const schemaFailure = await GET(new Request('http://localhost/api/internal/operations/snapshot', { headers: { authorization: 'Bearer operational-secret' } }));
    assert.equal(schemaFailure.status, 200);
    const schemaFailureBody = await schemaFailure.json() as { snapshot: typeof runtimeSnapshot; alerts: Array<{ id: string }> };
    assert.equal(schemaFailureBody.snapshot.schema.verified, false);
    assert.deepEqual(schemaFailureBody.alerts.map((alert) => alert.id), ['migration_failure']);
    await admin.unsafe(`
      alter table "${schemaName}".operational_signals drop constraint operational_signals_type_check,
      add constraint operational_signals_type_check check (signal_type in ('internal_trigger_failure', 'provider_failure', 'capacity_blocked', 'unknown_failure'))
    `);
    assert.deepEqual(await verifyOperationalSchema(db), { verified: true, reason: 'verified' });
    await admin.unsafe(`drop table "${schemaName}".activity_logs`);
    const runtimeFailure = await GET(new Request('http://localhost/api/internal/operations/snapshot', { headers: { authorization: 'Bearer operational-secret' } }));
    assert.equal(runtimeFailure.status, 500);
    assert.equal(runtimeFailure.headers.get('Cache-Control'), 'no-store');
    const runtimeFailureBody = await runtimeFailure.text();
    assert.equal(runtimeFailureBody, '');
    assert.doesNotMatch(runtimeFailureBody, /postgres|relation|activity_logs|select|stack|error/i);
    if (originalSecret === undefined) delete process.env.OPERATIONAL_SNAPSHOT_SECRET;
    else process.env.OPERATIONAL_SNAPSHOT_SECRET = originalSecret;
  } finally {
    if (appClient) await appClient.end();
    await admin.unsafe('drop schema if exists drizzle cascade');
    await admin.unsafe(`drop schema if exists "${schemaName}" cascade`);
    await admin.end();
  }
});
