import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { register } from 'node:module';
import test from 'node:test';
import postgres from 'postgres';

register('../test/typescript-path-loader.mjs', import.meta.url);

test('production job leases enforce claim, heartbeat, expiry, and token ownership', {
  skip: !process.env.PHASE1A_TEST_DATABASE_URL,
}, async () => {
  const configuredUrl = process.env.PHASE1A_TEST_DATABASE_URL;
  assert.ok(configuredUrl, 'PHASE1A_TEST_DATABASE_URL is required');
  const parsed = new URL(configuredUrl);
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(parsed.hostname));
  assert.equal(parsed.pathname.replace(/^\//, ''), 'disburse_phase1a_test');

  const schemaName = `durable_${randomUUID().replaceAll('-', '')}`;
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
        cancellation_reason varchar(40), cancellation_requested_at timestamp,
        failure_reason text, failure_code varchar(80), failure_class varchar(40),
        logical_job_key text, root_job_id integer, parent_job_id integer,
        recovery_attempt integer not null default 0, recovery_mode varchar(30),
        created_at timestamp not null default now(), updated_at timestamp not null default now()
      );
      create table "${schemaName}"."pipeline_scheduler_state" (
        id integer primary key default 1 check (id = 1), owner_token text,
        lease_expires_at timestamp, heartbeat_at timestamp,
        reconciliation_cursor integer, reconciliation_cycle bigint not null default 0,
        reconciliation_progress_at timestamp, reconciliation_progress_count bigint not null default 0,
        updated_at timestamp not null default now()
      );
      create table "${schemaName}"."clip_candidates" (
        id serial primary key, rank integer, created_at timestamp not null default now()
      );
      create table "${schemaName}"."projects" (
        id serial primary key, user_id integer not null, name varchar(150) not null,
        description text, is_saved boolean not null default false, expires_at timestamp,
        saved_at timestamp, deletion_requested_at timestamp,
        created_at timestamp not null default now(), updated_at timestamp not null default now()
      );
      create table "${schemaName}"."source_assets" (
        id serial primary key, user_id integer not null, project_id integer not null,
        title varchar(150) not null, asset_type varchar(50) not null,
        original_filename varchar(255), mime_type varchar(100), storage_key text,
        storage_url text not null, file_size_bytes bigint, thumbnail_storage_key text,
        thumbnail_mime_type varchar(100), thumbnail_width integer, thumbnail_height integer,
        status varchar(20) not null default 'uploaded', retention_status varchar(20),
        expires_at timestamp, saved_at timestamp, deleted_at timestamp,
        storage_deleted_at timestamp, deletion_requested_at timestamp,
        deletion_reason text, failure_reason text,
        created_at timestamp not null default now(), updated_at timestamp not null default now()
      );
      create table "${schemaName}"."transcripts" (
        id serial primary key, user_id integer not null, source_asset_id integer not null unique,
        status varchar(20) not null default 'pending', failure_reason text,
        created_at timestamp not null default now(), updated_at timestamp not null default now()
      );
      create table "${schemaName}"."job_effect_checkpoints" (
        id serial primary key, job_id integer not null, effect_key text not null,
        job_type varchar(50) not null, status varchar(30) not null,
        result jsonb, external_effect_started_at timestamp, completed_at timestamp,
        created_at timestamp not null default now(), updated_at timestamp not null default now(),
        unique (job_id, effect_key)
      );
    `);

    const isolatedUrl = new URL(configuredUrl);
    isolatedUrl.searchParams.set('options', `-csearch_path=${schemaName}`);
    process.env.POSTGRES_URL = isolatedUrl.toString();

    const { client, db } = await import('../db/drizzle.ts');
    appClient = client;
    const { jobs, JobStatus, JobType } = await import('../db/schema.ts');
    const {
      claimNextJob,
      enqueueTranscriptionJob,
      heartbeatJobLease,
      markJobCompleted,
      markJobFailed,
      requeueJob,
      JobEnqueueBlockedError,
      JobLeaseLostError,
    } = await import('./job-service.ts');

    await admin.unsafe(
      `insert into "${schemaName}"."projects" (id, user_id, name) values (1, 1, 'project');
       insert into "${schemaName}"."source_assets"
         (id, user_id, project_id, title, asset_type, storage_url)
         values
           (1, 1, 1, 'one', 'uploaded_file', 'local'),
           (2, 1, 1, 'two', 'uploaded_file', 'local'),
           (3, 1, 1, 'three', 'uploaded_file', 'local'),
           (4, 1, 1, 'four', 'uploaded_file', 'local'),
           (10, 1, 1, 'ten', 'uploaded_file', 'local');
       insert into "${schemaName}"."transcripts" (user_id, source_asset_id) values (1, 10);`
    );
    const enqueued = await Promise.all([
      enqueueTranscriptionJob(10, 1),
      enqueueTranscriptionJob(10, 1),
    ]);
    assert.equal(enqueued[0]!.id, enqueued[1]!.id);
    const identityCount = await admin.unsafe(
      `select count(*)::int as count from "${schemaName}"."jobs" where idempotency_key = 'transcribe_source_asset:source:10:v1'`
    );
    assert.equal(identityCount[0].count, 1);

    await db.delete(jobs);

    await db.insert(jobs).values({
      type: JobType.TRANSCRIBE_SOURCE_ASSET,
      idempotencyKey: 'claim-one',
      payload: { sourceAssetId: 1, userId: 1 },
    });
    const [first, second] = await Promise.all([claimNextJob(), claimNextJob()]);
    const claimed = first ?? second;
    assert.ok(claimed);
    assert.equal(first === null || second === null, true);
    assert.equal(claimed.attemptCount, 1);
    assert.ok(claimed.leaseToken);

    const oldExpiry = claimed.leaseExpiresAt!;
    assert.equal(await heartbeatJobLease(claimed.id, claimed.leaseToken!), true);
    const heartbeated = await db.query.jobs.findFirst({ where: (row, { eq }) => eq(row.id, claimed.id) });
    assert.ok(
      new Date(heartbeated!.leaseExpiresAt!).getTime() >=
        new Date(oldExpiry).getTime()
    );
    await assert.rejects(markJobCompleted(claimed.id, 'stale-token'), JobLeaseLostError);
    assert.equal(await markJobFailed(claimed.id, 'stale', 'stale-token'), false);
    await assert.rejects(requeueJob(claimed.id, 'stale-token'), JobLeaseLostError);
    await requeueJob(claimed.id, claimed.leaseToken!);

    const reclaimed = await claimNextJob();
    assert.ok(reclaimed);
    assert.equal(reclaimed.attemptCount, 2);
    await markJobCompleted(reclaimed.id, reclaimed.leaseToken!);
    const completed = await db.query.jobs.findFirst({ where: (row, { eq }) => eq(row.id, reclaimed.id) });
    assert.equal(completed!.status, JobStatus.COMPLETED);

    await db.insert(jobs).values({
      type: JobType.TRANSCRIBE_SOURCE_ASSET,
      status: JobStatus.PROCESSING,
      idempotencyKey: 'expired',
      payload: { sourceAssetId: 2, userId: 1 },
      attemptCount: 2,
      leaseToken: 'expired-token',
      leaseExpiresAt: new Date(0),
    });
    await admin.unsafe(`
      insert into "${schemaName}"."job_effect_checkpoints"
        (job_id, effect_key, job_type, status)
      select id, 'primary_external_effect_v1', type, 'prepared'
      from "${schemaName}"."jobs" where idempotency_key = 'expired'
    `);
    const expired = await claimNextJob();
    const expiredRow = await db.query.jobs.findFirst({
      where: (row, { eq }) => eq(row.idempotencyKey, 'expired'),
    });
    assert.ok(expired, JSON.stringify(expiredRow));
    assert.equal(expired.attemptCount, 3);
    assert.notEqual(expired.leaseToken, 'expired-token');
    assert.equal(await heartbeatJobLease(expired.id, 'expired-token'), false);

    await db.insert(jobs).values({
      type: JobType.TRANSCRIBE_SOURCE_ASSET,
      idempotencyKey: 'exhausted',
      payload: { sourceAssetId: 3, userId: 1 },
      attemptCount: 3,
      maxAttempts: 3,
    });
    await markJobCompleted(expired.id, expired.leaseToken!);
    assert.equal(await claimNextJob(), null);
    const exhausted = await db.query.jobs.findFirst({
      where: (row, { eq }) => eq(row.idempotencyKey, 'exhausted'),
    });
    assert.equal(exhausted!.status, JobStatus.FAILED);
    assert.match(exhausted!.failureReason!, /maximum number of attempts/);

    await db.insert(jobs).values({
      type: JobType.TRANSCRIBE_SOURCE_ASSET,
      status: JobStatus.PROCESSING,
      idempotencyKey: 'active-old-job',
      payload: { sourceAssetId: 4, userId: 1 },
      attemptCount: 1,
      startedAt: new Date(0),
      leaseToken: 'active-token',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    assert.equal(await claimNextJob(), null);
    const active = await db.query.jobs.findFirst({
      where: (row, { eq }) => eq(row.idempotencyKey, 'active-old-job'),
    });
    assert.equal(active!.status, JobStatus.PROCESSING);
    assert.equal(active!.leaseToken, 'active-token');

    await admin.unsafe(`
      update "${schemaName}"."jobs"
      set cancellation_requested_at = now(), cancellation_reason = 'project_deleted'
      where idempotency_key = 'active-old-job'
    `);
    assert.equal(await heartbeatJobLease(active!.id, 'active-token'), false);
    await assert.rejects(requeueJob(active!.id, 'active-token'), JobLeaseLostError);
    await admin.unsafe(`
      update "${schemaName}"."jobs"
      set lease_expires_at = now() - interval '1 second'
      where idempotency_key = 'active-old-job'
    `);
    assert.equal(await claimNextJob(), null);
    const cancelledAfterExpiry = await db.query.jobs.findFirst({
      where: (row, { eq }) => eq(row.idempotencyKey, 'active-old-job'),
    });
    assert.equal(cancelledAfterExpiry!.status, JobStatus.CANCELLED);
    assert.equal(cancelledAfterExpiry!.cancellationReason, 'project_deleted');

    await admin.unsafe(`
      update "${schemaName}"."projects"
      set deletion_requested_at = now()
      where id = 1
    `);
    await assert.rejects(
      enqueueTranscriptionJob(10, 1),
      JobEnqueueBlockedError
    );
  } finally {
    await appClient?.end();
    await admin.unsafe(`drop schema if exists "${schemaName}" cascade`);
    await admin.end();
  }
});
