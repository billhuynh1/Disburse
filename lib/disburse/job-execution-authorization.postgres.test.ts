import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { register } from 'node:module';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';

register('../test/typescript-path-loader.mjs', import.meta.url);

test('production authorization fences lifecycle and lease authority', {
  skip: !process.env.PHASE1A_TEST_DATABASE_URL,
}, async () => {
  const configuredUrl = process.env.PHASE1A_TEST_DATABASE_URL!;
  const parsed = new URL(configuredUrl);
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(parsed.hostname));
  assert.equal(parsed.pathname.replace(/^\//, ''), 'disburse_phase1a_test');
  const schemaName = `authorization_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(configuredUrl, { max: 1 });
  let appClient: { end: () => Promise<void> } | undefined;

  try {
    await admin.unsafe(`create schema "${schemaName}"`);
    await admin.unsafe(`
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
      create table "${schemaName}"."content_packs" (
        id serial primary key, user_id integer not null, project_id integer not null,
        source_asset_id integer not null, transcript_id integer, kind varchar(50) not null default 'general',
        name varchar(150) not null, instructions text, generation_run_id text not null,
        status varchar(20) not null default 'pending', failure_reason text,
        created_at timestamp not null default now(), updated_at timestamp not null default now()
      );
      create table "${schemaName}"."jobs" (
        id serial primary key, type varchar(50) not null, status varchar(20) not null default 'pending',
        idempotency_key text not null unique, payload jsonb not null, attempt_count integer not null default 0,
        max_attempts integer not null default 3, available_at timestamp not null default now(), started_at timestamp,
        heartbeat_at timestamp, lease_token text, lease_expires_at timestamp, completed_at timestamp,
        cancellation_reason varchar(40), cancellation_requested_at timestamp, failure_reason text,
        created_at timestamp not null default now(), updated_at timestamp not null default now()
      );
      create table "${schemaName}"."effects" (id serial primary key, value text not null);
      create table "${schemaName}"."clip_candidates" (
        id serial primary key, user_id integer not null, content_pack_id integer not null,
        source_asset_id integer not null, transcript_id integer not null, rank integer not null,
        start_time_ms integer not null, end_time_ms integer not null, duration_ms integer not null,
        hook text not null, title varchar(150) not null, caption_copy text not null,
        summary text not null, transcript_excerpt text not null, why_it_works text not null,
        platform_fit text not null, confidence integer not null, generation_run_id text not null,
        review_status varchar(30) not null default 'pending',
        facecam_detection_status varchar(20) not null default 'not_started',
        facecam_detection_failure_reason text, facecam_detection_debug_reason text,
        facecam_detected_at timestamp, created_at timestamp not null default now(),
        updated_at timestamp not null default now()
      );
    `);
    const isolatedUrl = new URL(configuredUrl);
    isolatedUrl.searchParams.set('options', `-csearch_path=${schemaName}`);
    process.env.POSTGRES_URL = isolatedUrl.toString();
    const { client, db } = await import('../db/drizzle.ts');
    appClient = client;
    const { jobs, JobStatus, JobType } = await import('../db/schema.ts');
    const {
      assertJobExecutionAuthorized,
      withAuthorizedJobTransaction,
      JobExecutionUnauthorizedError,
    } = await import('./job-execution-authorization.ts');
    const {
      markJobCompleted,
      markJobFailed,
      withAuthorizedJobCompletion,
      withAuthorizedJobFailure,
      JobLeaseLostError,
    } =
      await import('./job-service.ts');

    await admin.unsafe(`
      insert into "${schemaName}"."projects" (id, user_id, name) values (1, 1, 'project');
      insert into "${schemaName}"."source_assets"
        (id, user_id, project_id, title, asset_type, storage_url)
        values (1, 1, 1, 'source', 'uploaded_file', 'local');
      insert into "${schemaName}"."content_packs"
        (id, user_id, project_id, source_asset_id, name, generation_run_id)
        values (1, 1, 1, 1, 'pack', 'run-a');
    `);

    const insertJob = async (overrides: Record<string, unknown> = {}) => {
      const [job] = await db.insert(jobs).values({
        type: JobType.TRANSCRIBE_SOURCE_ASSET,
        status: JobStatus.PROCESSING,
        idempotencyKey: randomUUID(),
        payload: { sourceAssetId: 1, userId: 1 },
        leaseToken: 'token-a',
        leaseExpiresAt: new Date(Date.now() + 60_000),
        ...overrides,
      }).returning();
      return job;
    };
    const expectReason = async (promise: Promise<unknown>, reason: string) => {
      await assert.rejects(promise, (error: unknown) =>
        error instanceof JobExecutionUnauthorizedError && error.reason === reason
      );
    };

    const valid = await insertJob();
    const context = await assertJobExecutionAuthorized({ jobId: valid.id, leaseToken: 'token-a' });
    assert.equal(context.projectId, 1);
    assert.equal(context.sourceAssetId, 1);

    const unsupported = await insertJob({ type: 'unsupported' });
    await expectReason(assertJobExecutionAuthorized({ jobId: unsupported.id, leaseToken: 'token-a' }), 'invalid_job_type');
    const malformed = await insertJob({ payload: { sourceAssetId: 'bad' } });
    await expectReason(assertJobExecutionAuthorized({ jobId: malformed.id, leaseToken: 'token-a' }), 'invalid_payload');
    await expectReason(assertJobExecutionAuthorized({ jobId: 999999, leaseToken: 'x' }), 'job_missing');
    const pending = await insertJob({ status: JobStatus.PENDING });
    await expectReason(assertJobExecutionAuthorized({ jobId: pending.id, leaseToken: 'token-a' }), 'job_not_processing');
    await expectReason(assertJobExecutionAuthorized({ jobId: valid.id, leaseToken: 'wrong' }), 'lease_mismatch');
    const missingSource = await insertJob({ payload: { sourceAssetId: 999, userId: 1 } });
    await expectReason(assertJobExecutionAuthorized({ jobId: missingSource.id, leaseToken: 'token-a' }), 'source_asset_missing');
    await admin.unsafe(`update "${schemaName}"."source_assets" set project_id = 999 where id = 1`);
    await expectReason(assertJobExecutionAuthorized({ jobId: valid.id, leaseToken: 'token-a' }), 'project_missing');
    await admin.unsafe(`update "${schemaName}"."source_assets" set project_id = 1 where id = 1`);
    const missingPack = await insertJob({
      type: JobType.GENERATE_SHORT_FORM_PACK,
      payload: { sourceAssetId: 1, contentPackId: 999, userId: 1, generationRunId: 'run-a' },
    });
    await expectReason(assertJobExecutionAuthorized({ jobId: missingPack.id, leaseToken: 'token-a' }), 'related_record_missing');

    const expired = await insertJob({ leaseExpiresAt: new Date(0) });
    await expectReason(assertJobExecutionAuthorized({ jobId: expired.id, leaseToken: 'token-a' }), 'lease_expired');
    const cancelled = await insertJob({ cancellationRequestedAt: new Date() });
    await expectReason(assertJobExecutionAuthorized({ jobId: cancelled.id, leaseToken: 'token-a' }), 'cancellation_requested');

    await admin.unsafe(`update "${schemaName}"."projects" set deletion_requested_at = now() where id = 1`);
    await expectReason(assertJobExecutionAuthorized({ jobId: valid.id, leaseToken: 'token-a' }), 'project_deleting');
    await admin.unsafe(`update "${schemaName}"."projects" set deletion_requested_at = null where id = 1`);
    await admin.unsafe(`update "${schemaName}"."source_assets" set deletion_requested_at = now() where id = 1`);
    await expectReason(assertJobExecutionAuthorized({ jobId: valid.id, leaseToken: 'token-a' }), 'source_asset_deleting');
    await admin.unsafe(`update "${schemaName}"."source_assets" set deletion_requested_at = null where id = 1`);

    const staleGeneration = await insertJob({
      type: JobType.GENERATE_SHORT_FORM_PACK,
      payload: { sourceAssetId: 1, contentPackId: 1, userId: 1, generationRunId: 'run-b' },
    });
    await expectReason(assertJobExecutionAuthorized({ jobId: staleGeneration.id, leaseToken: 'token-a' }), 'generation_superseded');
    const mismatch = await insertJob({ payload: { sourceAssetId: 1, userId: 2 } });
    await expectReason(assertJobExecutionAuthorized({ jobId: mismatch.id, leaseToken: 'token-a' }), 'relationship_mismatch');

    let callbackRan = false;
    await assert.rejects(withAuthorizedJobTransaction(
      { jobId: expired.id, leaseToken: 'token-a' },
      async () => { callbackRan = true; }
    ));
    assert.equal(callbackRan, false);

    await withAuthorizedJobTransaction(
      { jobId: valid.id, leaseToken: 'token-a' },
      async (tx) => { await tx.execute(sql`insert into "effects" (value) values ('committed')`); }
    );
    const committed = await admin.unsafe(`select count(*)::int as count from "${schemaName}"."effects"`);
    assert.equal(committed[0].count, 1);

    await assert.rejects(db.transaction(async (tx) => {
      await withAuthorizedJobTransaction(
        { jobId: valid.id, leaseToken: 'token-a' },
        async (outer) => { await outer.execute(sql`insert into "effects" (value) values ('rolled-back')`); },
        tx
      );
      throw new Error('rollback');
    }));
    const afterRollback = await admin.unsafe(`select count(*)::int as count from "${schemaName}"."effects"`);
    assert.equal(afterRollback[0].count, 1);

    await assert.rejects(markJobCompleted(expired.id, 'token-a'), JobLeaseLostError);
    assert.equal(await markJobFailed(expired.id, 'failure', 'token-a'), false);
    const contender = postgres(isolatedUrl.toString(), { max: 1 });
    const delay = (milliseconds: number) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds));

    let releaseGuard!: () => void;
    let guardEntered!: () => void;
    const guardEnteredPromise = new Promise<void>((resolve) => { guardEntered = resolve; });
    const guardHold = new Promise<void>((resolve) => { releaseGuard = resolve; });
    const guardWins = withAuthorizedJobTransaction(
      { jobId: valid.id, leaseToken: 'token-a' },
      async () => { guardEntered(); await guardHold; }
    );
    await guardEnteredPromise;
    let deletionFinished = false;
    const waitingDeletion = contender.begin(async (tx) => {
      await tx`update projects set deletion_requested_at = clock_timestamp() where id = 1`;
      deletionFinished = true;
    });
    await delay(30);
    assert.equal(deletionFinished, false);
    releaseGuard();
    await guardWins;
    await waitingDeletion;
    await contender`update projects set deletion_requested_at = null where id = 1`;

    let releaseDeletion!: () => void;
    let deletionLocked!: () => void;
    const deletionLockedPromise = new Promise<void>((resolve) => { deletionLocked = resolve; });
    const deletionHold = new Promise<void>((resolve) => { releaseDeletion = resolve; });
    const deletionWins = contender.begin(async (tx) => {
      await tx`update projects set deletion_requested_at = clock_timestamp() where id = 1`;
      deletionLocked();
      await deletionHold;
    });
    await deletionLockedPromise;
    let blockedCallbackRan = false;
    const blockedGuard = withAuthorizedJobTransaction(
      { jobId: valid.id, leaseToken: 'token-a' },
      async () => { blockedCallbackRan = true; }
    );
    await delay(30);
    releaseDeletion();
    await deletionWins;
    await expectReason(blockedGuard, 'project_deleting');
    assert.equal(blockedCallbackRan, false);
    await contender`update projects set deletion_requested_at = null where id = 1`;

    await contender`update jobs set lease_expires_at = clock_timestamp() + interval '75 milliseconds' where id = ${valid.id}`;
    let releaseLeaseLock!: () => void;
    let leaseLocked!: () => void;
    const leaseLockedPromise = new Promise<void>((resolve) => { leaseLocked = resolve; });
    const leaseLockHold = new Promise<void>((resolve) => { releaseLeaseLock = resolve; });
    const leaseBlocker = contender.begin(async (tx) => {
      await tx`select id from projects where id = 1 for update`;
      leaseLocked();
      await leaseLockHold;
    });
    await leaseLockedPromise;
    const expiringGuard = withAuthorizedJobTransaction(
      { jobId: valid.id, leaseToken: 'token-a' },
      async () => undefined
    );
    await delay(120);
    releaseLeaseLock();
    await leaseBlocker;
    await expectReason(expiringGuard, 'lease_expired');

    await contender`update jobs set lease_token = 'token-a', lease_expires_at = clock_timestamp() + interval '1 minute' where id = ${valid.id}`;
    let releaseTokenLock!: () => void;
    let tokenLocked!: () => void;
    const tokenLockedPromise = new Promise<void>((resolve) => { tokenLocked = resolve; });
    const tokenLockHold = new Promise<void>((resolve) => { releaseTokenLock = resolve; });
    const tokenBlocker = contender.begin(async (tx) => {
      await tx`select id from projects where id = 1 for update`;
      tokenLocked();
      await tokenLockHold;
      await tx`update jobs set lease_token = 'token-b' where id = ${valid.id}`;
    });
    await tokenLockedPromise;
    let tokenACallbackRan = false;
    const tokenAGuard = withAuthorizedJobTransaction(
      { jobId: valid.id, leaseToken: 'token-a' },
      async () => { tokenACallbackRan = true; }
    );
    await delay(30);
    releaseTokenLock();
    await tokenBlocker;
    await expectReason(tokenAGuard, 'lease_mismatch');
    assert.equal(tokenACallbackRan, false);
    await assert.rejects(markJobCompleted(valid.id, 'token-a'), JobLeaseLostError);
    assert.equal(await markJobFailed(valid.id, 'failure', 'token-a'), false);
    const tokenB = await assertJobExecutionAuthorized({ jobId: valid.id, leaseToken: 'token-b' });
    assert.equal(tokenB.job.leaseToken, 'token-b');

    await expectReason(
      withAuthorizedJobCompletion(
        { jobId: valid.id, leaseToken: 'token-a' },
        async (tx) => {
          await tx.execute(sql`insert into "effects" (value) values ('stale-domain-write')`);
        }
      ),
      'lease_mismatch'
    );
    const staleEffects = await admin.unsafe(
      `select value from "${schemaName}"."effects" where value = 'stale-domain-write'`
    );
    assert.equal(staleEffects.length, 0);

    const externalWork = Promise.resolve().then(async () => {
      await contender`update jobs set cancellation_requested_at = clock_timestamp() where id = ${valid.id}`;
    });
    await externalWork;
    await expectReason(
      withAuthorizedJobTransaction(
        { jobId: valid.id, leaseToken: 'token-b' },
        async (tx) => {
          await tx.execute(sql`insert into "effects" (value) values ('post-external-write')`);
        }
      ),
      'cancellation_requested'
    );
    const postExternalEffects = await admin.unsafe(
      `select value from "${schemaName}"."effects" where value = 'post-external-write'`
    );
    assert.equal(postExternalEffects.length, 0);

    const blockedExternalJob = await insertJob({ leaseToken: 'external-token' });
    let releaseExternal!: () => void;
    let externalStarted!: () => void;
    const externalStartedPromise = new Promise<void>((resolve) => { externalStarted = resolve; });
    const externalHold = new Promise<void>((resolve) => { releaseExternal = resolve; });
    const blockedExternalWorker = (async () => {
      externalStarted();
      await externalHold;
      await withAuthorizedJobTransaction(
        { jobId: blockedExternalJob.id, leaseToken: 'external-token' },
        async (tx) => {
          await tx.execute(sql`insert into "effects" (value) values ('blocked-external-write')`);
        }
      );
    })();
    await externalStartedPromise;
    await contender`update jobs set cancellation_requested_at = clock_timestamp() where id = ${blockedExternalJob.id}`;
    releaseExternal();
    await expectReason(blockedExternalWorker, 'cancellation_requested');
    const blockedExternalEffects = await admin.unsafe(
      `select value from "${schemaName}"."effects" where value = 'blocked-external-write'`
    );
    assert.equal(blockedExternalEffects.length, 0);

    await contender`update content_packs set generation_run_id = 'run-a' where id = 1`;
    const generationJob = await insertJob({
      type: JobType.GENERATE_SHORT_FORM_PACK,
      payload: { sourceAssetId: 1, contentPackId: 1, userId: 1, generationRunId: 'run-a' },
      leaseToken: 'generation-token',
    });
    let releaseGeneration!: () => void;
    let generationExternalFinished!: () => void;
    const generationExternalFinishedPromise = new Promise<void>((resolve) => {
      generationExternalFinished = resolve;
    });
    const generationHold = new Promise<void>((resolve) => { releaseGeneration = resolve; });
    const staleGenerationWorker = (async () => {
      generationExternalFinished();
      await generationHold;
      await withAuthorizedJobTransaction(
        { jobId: generationJob.id, leaseToken: 'generation-token' },
        async (tx) => {
          await tx.execute(sql`insert into "effects" (value) values ('stale-generation-write')`);
        }
      );
    })();
    await generationExternalFinishedPromise;
    await contender`update content_packs set generation_run_id = 'run-b' where id = 1`;
    releaseGeneration();
    await expectReason(staleGenerationWorker, 'generation_superseded');
    const staleGenerationEffects = await admin.unsafe(
      `select value from "${schemaName}"."effects" where value = 'stale-generation-write'`
    );
    assert.equal(staleGenerationEffects.length, 0);

    const failureJob = await insertJob({ leaseToken: 'failure-token' });
    await contender`update jobs set lease_token = 'replacement-token' where id = ${failureJob.id}`;
    await expectReason(
      withAuthorizedJobFailure(
        { jobId: failureJob.id, leaseToken: 'failure-token' },
        'domain failure',
        async (tx) => {
          await tx.execute(sql`insert into "effects" (value) values ('stale-failure-write')`);
        }
      ),
      'lease_mismatch'
    );
    const staleFailureEffects = await admin.unsafe(
      `select value from "${schemaName}"."effects" where value = 'stale-failure-write'`
    );
    assert.equal(staleFailureEffects.length, 0);

    const completionJob = await insertJob({ leaseToken: 'completion-token' });
    await assert.rejects(
      withAuthorizedJobCompletion(
        { jobId: completionJob.id, leaseToken: 'completion-token' },
        async (tx) => {
          await tx.execute(sql`insert into "effects" (value) values ('persisted-result')`);
          await tx.execute(sql`insert into "effects" (value) values ('downstream-enqueue')`);
          throw new Error('downstream enqueue failed');
        }
      ),
      /downstream enqueue failed/
    );
    const rolledBackCompletion = await admin.unsafe(
      `select status, lease_token from "${schemaName}"."jobs" where id = ${completionJob.id}`
    );
    assert.equal(rolledBackCompletion[0].status, JobStatus.PROCESSING);
    assert.equal(rolledBackCompletion[0].lease_token, 'completion-token');
    const rolledBackCompletionEffects = await admin.unsafe(
      `select value from "${schemaName}"."effects" where value in ('persisted-result', 'downstream-enqueue')`
    );
    assert.equal(rolledBackCompletionEffects.length, 0);
    await contender.end();
  } finally {
    await appClient?.end();
    await admin.unsafe(`drop schema if exists "${schemaName}" cascade`);
    await admin.end();
  }
});
