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
  try {
    await admin.unsafe(`create schema "${schemaName}"`);
    await admin.unsafe(`
      create table "${schemaName}"."jobs" (
        id serial primary key, type varchar(50) not null, status varchar(20) not null default 'pending',
        idempotency_key text not null unique, payload jsonb not null, attempt_count integer not null default 0,
        max_attempts integer not null default 3, available_at timestamp not null default now(), started_at timestamp,
        heartbeat_at timestamp, lease_token text, lease_expires_at timestamp, completed_at timestamp,
        failure_reason text, created_at timestamp not null default now(), updated_at timestamp not null default now()
      );
      create table "${schemaName}"."clip_candidates" (
        id serial primary key, rank integer, created_at timestamp not null default now()
      );
      create table "${schemaName}"."source_assets" (
        id serial primary key, user_id integer not null, asset_type varchar(50) not null
      );
      create table "${schemaName}"."transcripts" (
        id serial primary key, user_id integer not null, source_asset_id integer not null unique,
        status varchar(20) not null default 'pending', failure_reason text,
        created_at timestamp not null default now(), updated_at timestamp not null default now()
      );
    `);

    const isolatedUrl = new URL(configuredUrl);
    isolatedUrl.searchParams.set('options', `-csearch_path=${schemaName}`);
    process.env.POSTGRES_URL = isolatedUrl.toString();

    const { client, db } = await import('../db/drizzle.ts');
    const { jobs, JobStatus, JobType } = await import('../db/schema.ts');
    const {
      claimNextJob,
      enqueueTranscriptionJob,
      heartbeatJobLease,
      markJobCompleted,
      markJobFailed,
      requeueJob,
      JobLeaseLostError,
    } = await import('./job-service.ts');

    await admin.unsafe(
      `insert into "${schemaName}"."source_assets" (id, user_id, asset_type) values (10, 1, 'uploaded_file');
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
    await client.end();
  } finally {
    await admin.unsafe(`drop schema if exists "${schemaName}" cascade`);
    await admin.end();
  }
});
