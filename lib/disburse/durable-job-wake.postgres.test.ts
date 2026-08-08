import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { register } from 'node:module';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';

register('../test/typescript-path-loader.mjs', import.meta.url);

test('short-form job wake is immediately claimable in a non-UTC PostgreSQL session', {
  skip: !process.env.PHASE1A_TEST_DATABASE_URL,
}, async () => {
  const configuredUrl = process.env.PHASE1A_TEST_DATABASE_URL!;
  const parsed = new URL(configuredUrl);
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(parsed.hostname));
  assert.equal(parsed.pathname.replace(/^\//, ''), 'disburse_phase1a_test');

  const schemaName = `wake_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(configuredUrl, { max: 1 });
  let appClient: { end: () => Promise<void> } | undefined;

  try {
    await admin.unsafe(`create schema "${schemaName}"`);
    await admin.unsafe(`
      create table "${schemaName}"."jobs" (
        id serial primary key, type varchar(50) not null, status varchar(20) not null default 'pending',
        idempotency_key text not null unique, payload jsonb not null, attempt_count integer not null default 0,
        max_attempts integer not null default 3, available_at timestamp not null default now(), started_at timestamp,
        heartbeat_at timestamp, lease_token text, lease_expires_at timestamp, completed_at timestamp,
        cancellation_reason varchar(40), cancellation_requested_at timestamp, failure_reason text,
        failure_code varchar(80), failure_class varchar(40), logical_job_key text,
        root_job_id integer, parent_job_id integer, recovery_attempt integer not null default 0,
        recovery_mode varchar(30), created_at timestamp not null default now(), updated_at timestamp not null default now()
      );
      create table "${schemaName}"."pipeline_scheduler_state" (
        id integer primary key default 1 check (id = 1), owner_token text,
        lease_expires_at timestamp, heartbeat_at timestamp, reconciliation_cursor integer,
        reconciliation_cycle bigint not null default 0, reconciliation_progress_at timestamp,
        reconciliation_progress_count bigint not null default 0, updated_at timestamp not null default now()
      );
      create table "${schemaName}"."clip_candidates" (
        id serial primary key, rank integer, created_at timestamp not null default now()
      );
    `);

    const isolatedUrl = new URL(configuredUrl);
    isolatedUrl.searchParams.set(
      'options',
      `-csearch_path=${schemaName} -cTimeZone=America/Los_Angeles`
    );
    process.env.POSTGRES_URL = isolatedUrl.toString();

    const { client, db } = await import('../db/drizzle.ts');
    appClient = client;
    const { jobs, JobStatus, JobType } = await import('../db/schema.ts');
    const {
      claimNextJob,
      wakeShortFormPackJobsForSourceAsset,
    } = await import('./job-service.ts');

    const [generationJob] = await db.insert(jobs).values({
      type: JobType.GENERATE_SHORT_FORM_PACK,
      idempotencyKey: 'wake-timezone-generation',
      payload: {
        sourceAssetId: 1,
        contentPackId: 1,
        userId: 1,
        generationRunId: 'wake-timezone-run',
      },
      availableAt: sql<Date>`clock_timestamp() + interval '1 hour'`,
    }).returning();
    const [delayedJob] = await db.insert(jobs).values({
      type: JobType.TRANSCRIBE_SOURCE_ASSET,
      idempotencyKey: 'wake-timezone-delayed',
      payload: { sourceAssetId: 2, userId: 1 },
      availableAt: sql<Date>`clock_timestamp() + interval '1 hour'`,
    }).returning();

    const beforeWake = await db.execute<{
      timeZone: string;
      generationFuture: boolean;
      delayedFuture: boolean;
    }>(sql`
      select
        current_setting('TimeZone') as "timeZone",
        bool_or(case when ${jobs.id} = ${generationJob.id} then ${jobs.availableAt} > clock_timestamp() end) as "generationFuture",
        bool_or(case when ${jobs.id} = ${delayedJob.id} then ${jobs.availableAt} > clock_timestamp() end) as "delayedFuture"
      from ${jobs}
    `);
    assert.equal(beforeWake[0]!.timeZone, 'America/Los_Angeles');
    assert.equal(beforeWake[0]!.generationFuture, true);
    assert.equal(beforeWake[0]!.delayedFuture, true);

    await wakeShortFormPackJobsForSourceAsset(1);

    const afterWake = await db.execute<{ eligible: boolean }>(sql`
      select exists (
        select 1 from ${jobs}
        where ${jobs.id} = ${generationJob.id}
          and ${jobs.status} = ${JobStatus.PENDING}
          and ${jobs.cancellationRequestedAt} is null
          and ${jobs.attemptCount} < ${jobs.maxAttempts}
          and ${jobs.availableAt} <= clock_timestamp()
      ) as eligible
    `);
    assert.equal(afterWake[0]!.eligible, true);

    const claimed = await claimNextJob();
    assert.equal(claimed?.id, generationJob.id);

    const delayedAfterWake = await db.execute<{ future: boolean }>(sql`
      select ${jobs.availableAt} > clock_timestamp() as future
      from ${jobs}
      where ${jobs.id} = ${delayedJob.id}
    `);
    assert.equal(delayedAfterWake[0]!.future, true);
  } finally {
    await appClient?.end();
    await admin.unsafe(`drop schema if exists "${schemaName}" cascade`);
    await admin.end();
  }
});
