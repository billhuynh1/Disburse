import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { register } from 'node:module';
import test from 'node:test';
import postgres from 'postgres';

register('../test/typescript-path-loader.mjs', import.meta.url);

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

test('scheduler ownership, cursor fencing, serialized capacity, and bounded recovery', {
  skip: !process.env.PHASE1A_TEST_DATABASE_URL,
}, async () => {
  const configuredUrl = process.env.PHASE1A_TEST_DATABASE_URL;
  assert.ok(configuredUrl);
  const parsed = new URL(configuredUrl);
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(parsed.hostname));
  assert.equal(parsed.pathname.replace(/^\//, ''), 'disburse_phase1a_test');

  const schemaName = `phase4_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(configuredUrl, { max: 3 });
  let appClient: { end: () => Promise<void> } | undefined;
  try {
    await admin.unsafe(`create schema "${schemaName}"`);
    await admin.unsafe(`
      create table "${schemaName}".pipeline_scheduler_state (
        id integer primary key default 1 check (id = 1), owner_token text,
        lease_expires_at timestamp, heartbeat_at timestamp,
        reconciliation_cursor integer, reconciliation_cycle bigint not null default 0,
        updated_at timestamp not null default now()
      );
      insert into "${schemaName}".pipeline_scheduler_state (id) values (1);
      create table "${schemaName}".jobs (
        id serial primary key, type varchar(50) not null,
        status varchar(20) not null default 'pending', idempotency_key text not null unique,
        payload jsonb not null, attempt_count integer not null default 0,
        max_attempts integer not null default 3, available_at timestamp not null default now(),
        started_at timestamp, heartbeat_at timestamp, lease_token text,
        lease_expires_at timestamp, completed_at timestamp,
        cancellation_reason varchar(40), cancellation_requested_at timestamp,
        failure_reason text, created_at timestamp not null default now(),
        updated_at timestamp not null default now()
      );
      create table "${schemaName}".clip_candidates (
        id serial primary key, rank integer, created_at timestamp not null default now()
      );
      create table "${schemaName}".projects (
        id serial primary key, user_id integer not null, name varchar(150) not null,
        description text, is_saved boolean not null default false, expires_at timestamp,
        saved_at timestamp, deletion_requested_at timestamp,
        created_at timestamp not null default now(), updated_at timestamp not null default now()
      );
      create table "${schemaName}".source_assets (
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
      create table "${schemaName}".source_asset_thumbnail_variants (
        id serial primary key, source_asset_id integer not null, variant varchar(50) not null,
        storage_key text not null, mime_type varchar(100) not null,
        width integer not null, height integer not null,
        created_at timestamp not null default now(), updated_at timestamp not null default now(),
        unique (source_asset_id, variant)
      );
    `);

    const isolatedUrl = new URL(configuredUrl);
    isolatedUrl.searchParams.set('options', `-csearch_path=${schemaName}`);
    process.env.POSTGRES_URL = isolatedUrl.toString();

    const { client, db } = await import('../db/drizzle.ts');
    appClient = client;
    const { eq } = await import('drizzle-orm');
    const { jobs, JobStatus, JobType } = await import('../db/schema.ts');
    const scheduler = await import('./pipeline-scheduler-service.ts');
    const jobService = await import('./job-service.ts');
    const processor = await import('./pipeline-processor-service.ts');

    const [first, second] = await Promise.all([
      scheduler.acquirePipelineProcessor({ ownerToken: 'owner-a' }),
      scheduler.acquirePipelineProcessor({ ownerToken: 'owner-b' }),
    ]);
    const original = first ?? second;
    assert.ok(original);
    assert.equal(Number(Boolean(first)) + Number(Boolean(second)), 1);

    await admin.unsafe(`
      update "${schemaName}".pipeline_scheduler_state
      set lease_expires_at = clock_timestamp() - interval '1 second'
    `);
    const successor = await scheduler.acquirePipelineProcessor({ ownerToken: 'successor' });
    assert.ok(successor);
    assert.equal(await scheduler.heartbeatPipelineProcessor(original.ownerToken), false);
    assert.equal(await scheduler.releasePipelineProcessor(original.ownerToken), false);
    assert.equal(await scheduler.advancePipelineReconciliationCursor({
      ownerToken: original.ownerToken,
      expectedCursor: null,
      nextCursor: 4,
      wrap: false,
    }), null);

    const advanced = await scheduler.advancePipelineReconciliationCursor({
      ownerToken: successor.ownerToken,
      expectedCursor: null,
      nextCursor: 4,
      wrap: false,
    });
    assert.equal(advanced?.reconciliationCursor, 4);
    assert.equal(await scheduler.advancePipelineReconciliationCursor({
      ownerToken: successor.ownerToken,
      expectedCursor: 3,
      nextCursor: 5,
      wrap: false,
    }), null);
    const wrapped = await scheduler.advancePipelineReconciliationCursor({
      ownerToken: successor.ownerToken,
      expectedCursor: 4,
      nextCursor: null,
      wrap: true,
    });
    assert.equal(wrapped?.reconciliationCursor, null);
    assert.equal(wrapped?.reconciliationCycle, 1);
    await scheduler.releasePipelineProcessor(successor.ownerToken);

    process.env.MAX_RENDER_CONCURRENCY = '1';
    await db.insert(jobs).values([
      {
        type: JobType.RENDER_CLIP_CANDIDATE,
        idempotencyKey: 'render-a',
        payload: { clipCandidateId: 1, contentPackId: 1, sourceAssetId: 1, userId: 1,
          generationRunId: 'run', captionsEnabled: true },
      },
      {
        type: JobType.RENDER_CLIP_CANDIDATE,
        idempotencyKey: 'render-b',
        payload: { clipCandidateId: 2, contentPackId: 1, sourceAssetId: 1, userId: 1,
          generationRunId: 'run', captionsEnabled: true },
      },
    ]);
    const simultaneousClaims = await Promise.all([
      jobService.claimNextJob(),
      jobService.claimNextJob(),
    ]);
    assert.equal(simultaneousClaims.filter(Boolean).length, 1);
    const capacityOutcome = await jobService.claimNextJobWithOutcome();
    assert.equal(capacityOutcome.status, 'capacity_blocked');
    let capacityFollowUps = 0;
    const capacityProcessor = await processor.runPipelineProcessor({
      origin: 'internal',
      triggerFollowUp: () => {
        capacityFollowUps += 1;
      },
    });
    assert.equal(capacityProcessor.stopReason, 'capacity_blocked');
    assert.equal(capacityFollowUps, 0);
    const activeRender = simultaneousClaims.find(Boolean);
    assert.ok(activeRender);
    const activeRenderRow = (await db.select().from(jobs)).find(
      (job) => job.id === activeRender.id
    );
    assert.ok(activeRenderRow);
    assert.equal(activeRenderRow.status, 'processing');
    assert.equal(activeRenderRow.leaseToken, activeRender.leaseToken);
    await db.update(jobs).set({ status: JobStatus.COMPLETED }).where(eq(jobs.id, activeRender.id));
    const releasedCapacity = await jobService.claimNextJobWithOutcome();
    assert.equal(releasedCapacity.status, 'claimed');
    if (releasedCapacity.status === 'claimed') {
      await db.update(jobs).set({ status: JobStatus.COMPLETED })
        .where(eq(jobs.id, releasedCapacity.job.id));
    }

    await db.delete(jobs);
    process.env.MAX_FACECAM_CONCURRENCY = '1';
    await db.insert(jobs).values([
      { type: JobType.DETECT_CLIP_FACECAM, idempotencyKey: 'facecam-a',
        payload: { videoId: 1, sourceAssetId: 1, userId: 1 } },
      { type: JobType.DETECT_CLIP_FACECAM, idempotencyKey: 'facecam-b',
        payload: { videoId: 1, sourceAssetId: 1, userId: 1 } },
    ]);
    const facecamClaims = await Promise.all([
      jobService.claimNextJob(),
      jobService.claimNextJob(),
    ]);
    assert.equal(facecamClaims.filter(Boolean).length, 1);

    await db.delete(jobs);
    await db.insert(jobs).values({
      type: JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL,
      idempotencyKey: 'claimable-race',
      payload: { sourceAssetId: 1, userId: 1 },
    });
    const claimableRace = await Promise.all([
      jobService.claimNextJobWithOutcome(),
      jobService.claimNextJobWithOutcome(),
    ]);
    assert.equal(claimableRace.filter((outcome) => outcome.status === 'claimed').length, 1);
    assert.equal(claimableRace.filter((outcome) => outcome.status === 'queue_empty').length, 1);

    await db.delete(jobs);
    const past = new Date(0);
    const future = new Date(Date.now() + 60_000);
    await db.insert(jobs).values([
      { type: JobType.TRANSCRIBE_SOURCE_ASSET, status: JobStatus.PROCESSING,
        idempotencyKey: 'reclaim', payload: { sourceAssetId: 1, userId: 1 },
        attemptCount: 1, leaseToken: 'old', leaseExpiresAt: past },
      { type: JobType.TRANSCRIBE_SOURCE_ASSET, status: JobStatus.PROCESSING,
        idempotencyKey: 'exhaust', payload: { sourceAssetId: 2, userId: 1 },
        attemptCount: 3, maxAttempts: 3, leaseToken: 'old', leaseExpiresAt: past },
      { type: JobType.TRANSCRIBE_SOURCE_ASSET, status: JobStatus.PROCESSING,
        idempotencyKey: 'cancel', payload: { sourceAssetId: 3, userId: 1 },
        attemptCount: 1, leaseToken: 'old', leaseExpiresAt: past,
        cancellationRequestedAt: new Date(), cancellationReason: 'project_deleted' },
      { type: JobType.TRANSCRIBE_SOURCE_ASSET, status: JobStatus.PROCESSING,
        idempotencyKey: 'valid', payload: { sourceAssetId: 4, userId: 1 },
        attemptCount: 1, leaseToken: 'valid', leaseExpiresAt: future },
      { type: JobType.TRANSCRIBE_SOURCE_ASSET, status: JobStatus.PROCESSING,
        idempotencyKey: 'future-available', payload: { sourceAssetId: 5, userId: 1 },
        attemptCount: 1, leaseToken: 'old', leaseExpiresAt: past, availableAt: future },
      { type: JobType.TRANSCRIBE_SOURCE_ASSET, status: JobStatus.PROCESSING,
        idempotencyKey: 'null-lease', payload: { sourceAssetId: 6, userId: 1 },
        attemptCount: 1, leaseToken: 'old', leaseExpiresAt: null },
      { type: JobType.TRANSCRIBE_SOURCE_ASSET, status: JobStatus.PENDING,
        idempotencyKey: 'pending-cancel', payload: { sourceAssetId: 7, userId: 1 },
        cancellationRequestedAt: new Date(), cancellationReason: 'user_requested' },
      { type: JobType.TRANSCRIBE_SOURCE_ASSET, status: JobStatus.PENDING,
        idempotencyKey: 'pending-exhausted', payload: { sourceAssetId: 8, userId: 1 },
        attemptCount: 3, maxAttempts: 3 },
    ]);
    assert.equal(await jobService.recoverExpiredPipelineJobLeases(2), 2);
    assert.equal(await jobService.recoverExpiredPipelineJobLeases(100), 4);
    const recovered = await db.select().from(jobs);
    const status = Object.fromEntries(recovered.map((job) => [job.idempotencyKey, job.status]));
    assert.equal(status.reclaim, JobStatus.PENDING);
    assert.equal(status.exhaust, JobStatus.FAILED);
    assert.equal(status.cancel, JobStatus.CANCELLED);
    assert.equal(status.valid, JobStatus.PROCESSING);
    assert.equal(status['future-available'], JobStatus.PROCESSING);
    assert.equal(status['null-lease'], JobStatus.PENDING);
    assert.equal(status['pending-cancel'], JobStatus.CANCELLED);
    assert.equal(status['pending-exhausted'], JobStatus.FAILED);

    await db.delete(jobs);
    const empty = await processor.runPipelineProcessor({ origin: 'cron' });
    assert.equal(empty.stopReason, 'queue_empty');
    assert.equal(empty.followUpTriggered, false);

    const blocker = await scheduler.acquirePipelineProcessor({ ownerToken: 'blocker' });
    assert.ok(blocker);
    const busy = await processor.runPipelineProcessor({ origin: 'cron' });
    assert.equal(busy.stopReason, 'processor_busy');
    await scheduler.releasePipelineProcessor(blocker.ownerToken);

    await db.insert(jobs).values({
      type: JobType.RENDER_CLIP_CANDIDATE,
      idempotencyKey: 'runtime-ineligible',
      payload: { clipCandidateId: 1, contentPackId: 1, sourceAssetId: 1, userId: 1,
        generationRunId: 'run', captionsEnabled: true },
    });
    const runtimeStop = await processor.runPipelineProcessor({
      origin: 'cron',
      maxRuntimeMs: 100_000,
    });
    assert.equal(runtimeStop.stopReason, 'max_runtime');
    const ineligible = await db.query.jobs.findFirst({
      where: (row, { eq }) => eq(row.idempotencyKey, 'runtime-ineligible'),
    });
    assert.equal(ineligible?.status, JobStatus.PENDING);
    assert.equal(ineligible?.leaseToken, null);
    let shortBudgetFollowUps = 0;
    const permanentlyIneligible = await processor.runPipelineProcessor({
      origin: 'internal',
      maxRuntimeMs: 100_000,
      triggerFollowUp: () => {
        shortBudgetFollowUps += 1;
      },
    });
    assert.equal(permanentlyIneligible.stopReason, 'max_runtime');
    assert.equal(shortBudgetFollowUps, 0);

    let freshBudgetFollowUps = 0;
    const freshBudgetEligible = await processor.runPipelineProcessor({
      origin: 'internal',
      now: (() => {
        let calls = 0;
        return () => calls++ === 0 ? 0 : 650_000;
      })(),
      triggerFollowUp: () => {
        freshBudgetFollowUps += 1;
      },
    });
    assert.equal(freshBudgetEligible.stopReason, 'max_runtime');
    assert.equal(freshBudgetFollowUps, 1);

    process.env.RENDER_TIMEOUT_MS = '780000';
    const fatal = await processor.runPipelineProcessor({ origin: 'cron' });
    assert.equal(fatal.stopReason, 'fatal_error');
    const stillPending = await db.query.jobs.findFirst({
      where: (row, { eq }) => eq(row.idempotencyKey, 'runtime-ineligible'),
    });
    assert.equal(stillPending?.status, JobStatus.PENDING);
    delete process.env.RENDER_TIMEOUT_MS;

    await db.delete(jobs);
    await admin.unsafe(`
      insert into "${schemaName}".projects (id, user_id, name)
      values (10, 1, 'ten'), (20, 1, 'twenty')
    `);
    const budget = await processor.runPipelineProcessor({
      origin: 'cron',
      reconciliationProjects: 1,
    });
    assert.equal(budget.stopReason, 'reconciliation_budget');
    assert.deepEqual(budget.reconciledProjects, 1);

    await admin.unsafe(`
      update "${schemaName}".pipeline_scheduler_state
      set reconciliation_cursor = null, reconciliation_cycle = 0
    `);
    const partial = await processor.runPipelineProcessor({
      origin: 'cron',
      reconciliationProjects: 1,
      maxRuntimeMs: 6_000,
      now: (() => {
        let calls = 0;
        return () => calls++ === 0 ? 0 : 10_000;
      })(),
    });
    assert.equal(partial.stopReason, 'max_runtime');
    const cursorAfterPartial = await admin.unsafe(`
      select reconciliation_cursor from "${schemaName}".pipeline_scheduler_state
    `);
    assert.equal(cursorAfterPartial[0].reconciliation_cursor, null);

    await admin.unsafe(`
      insert into "${schemaName}".source_assets
        (id, user_id, project_id, title, asset_type, storage_url, status)
      values (99, 1, 20, 'failing-page', 'pasted_transcript', 'local', 'ready')
    `);
    const failedAfterCommit = await processor.runPipelineProcessor({
      origin: 'cron',
      reconciliationProjects: 10,
    });
    assert.equal(failedAfterCommit.stopReason, 'fatal_error');
    assert.equal(failedAfterCommit.reconciledProjects, 1);
    const cursorAfterFailure = await admin.unsafe(`
      select reconciliation_cursor, reconciliation_cycle
      from "${schemaName}".pipeline_scheduler_state
    `);
    assert.equal(cursorAfterFailure[0].reconciliation_cursor, null);
    assert.equal(Number(cursorAfterFailure[0].reconciliation_cycle), 0);
    await admin.unsafe(`delete from "${schemaName}".source_assets where id = 99`);
    const replayedPage = await processor.runPipelineProcessor({
      origin: 'cron',
      reconciliationProjects: 10,
    });
    assert.equal(replayedPage.reconciledProjects, 2);
    assert.equal(replayedPage.stopReason, 'queue_empty');
    assert.equal(replayedPage.reconciliationCycle, 1);

    await admin.unsafe(`
      update "${schemaName}".pipeline_scheduler_state
      set owner_token = null, lease_expires_at = null,
          reconciliation_cursor = 20, reconciliation_cycle = 0
    `);
    const wrapOwner = await scheduler.acquirePipelineProcessor({ ownerToken: 'wrap-owner' });
    assert.ok(wrapOwner);
    const concurrentWraps = await Promise.all([
      scheduler.advancePipelineReconciliationCursor({
        ownerToken: wrapOwner.ownerToken,
        expectedCursor: 20,
        nextCursor: null,
        wrap: true,
      }),
      scheduler.advancePipelineReconciliationCursor({
        ownerToken: wrapOwner.ownerToken,
        expectedCursor: 20,
        nextCursor: null,
        wrap: true,
      }),
    ]);
    assert.equal(concurrentWraps.filter(Boolean).length, 1);
    assert.equal(concurrentWraps.find(Boolean)?.reconciliationCycle, 1);
    await scheduler.releasePipelineProcessor(wrapOwner.ownerToken);

    await admin.unsafe(`
      update "${schemaName}".pipeline_scheduler_state
      set reconciliation_cursor = 20
    `);
    await admin.unsafe(`
      insert into "${schemaName}".source_assets
        (id, user_id, project_id, title, asset_type, storage_url, status)
      values (100, 1, 10, 'text', 'pasted_transcript', 'local', 'ready')
    `);
    await db.insert(jobs).values({
      type: JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL,
      idempotencyKey: 'bounded-one',
      payload: { sourceAssetId: 100, userId: 1 },
    });
    const maxJobs = await processor.runPipelineProcessor({
      origin: 'cron',
      maxJobs: 1,
    });
    assert.equal(maxJobs.stopReason, 'max_jobs');
    assert.equal(maxJobs.processedJobs, 1);
    const completedJob = await db.query.jobs.findFirst({
      where: (row, { eq }) => eq(row.idempotencyKey, 'bounded-one'),
    });
    assert.equal(completedJob?.status, JobStatus.COMPLETED);

    await db.delete(jobs);
    await admin.unsafe(`
      update "${schemaName}".pipeline_scheduler_state
      set reconciliation_cursor = 20
    `);
    await db.insert(jobs).values([
      { type: JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL, idempotencyKey: 'takeover-active',
        payload: { sourceAssetId: 100, userId: 1 } },
      { type: JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL, idempotencyKey: 'takeover-unclaimed',
        payload: { sourceAssetId: 100, userId: 1 } },
    ]);
    const jobStarted = deferred<Awaited<ReturnType<typeof jobService.claimNextJob>>>();
    const finishJob = deferred();
    const losingProcessor = processor.runPipelineProcessor({
      origin: 'cron',
      maxJobs: 2,
      processJob: async (job) => {
        jobStarted.resolve(job);
        await finishJob.promise;
        await jobService.markJobCompleted(job.id, job.leaseToken!);
      },
    });
    const activeJob = await jobStarted.promise;
    assert.ok(activeJob);
    await admin.unsafe(`
      update "${schemaName}".pipeline_scheduler_state
      set lease_expires_at = clock_timestamp() - interval '1 second'
    `);
    const takeover = await scheduler.acquirePipelineProcessor({ ownerToken: 'takeover' });
    assert.ok(takeover);
    finishJob.resolve();
    const ownershipLoss = await losingProcessor;
    assert.equal(ownershipLoss.stopReason, 'processor_busy');
    const takeoverRows = await db.select().from(jobs);
    assert.equal(
      takeoverRows.find((job) => job.id === activeJob.id)?.status,
      JobStatus.COMPLETED
    );
    assert.equal(
      takeoverRows.find((job) => job.idempotencyKey === 'takeover-unclaimed')?.status,
      JobStatus.PENDING
    );
    await scheduler.releasePipelineProcessor(takeover.ownerToken);

    await db.delete(jobs);
    await admin.unsafe(`
      update "${schemaName}".pipeline_scheduler_state
      set reconciliation_cursor = 20
    `);
    await db.insert(jobs).values([
      { type: JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL, idempotencyKey: 'handled-failure',
        payload: { sourceAssetId: 100, userId: 1 } },
      { type: JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL, idempotencyKey: 'after-failure',
        payload: { sourceAssetId: 100, userId: 1 } },
    ]);
    let handledCount = 0;
    const continued = await processor.runPipelineProcessor({
      origin: 'cron',
      maxJobs: 2,
      processJob: async (job) => {
        handledCount += 1;
        if (handledCount === 1) {
          assert.equal(await jobService.markJobFailed(
            job.id,
            'deterministic handled failure',
            job.leaseToken!
          ), true);
        } else {
          await jobService.markJobCompleted(job.id, job.leaseToken!);
        }
      },
    });
    assert.equal(continued.stopReason, 'max_jobs');
    assert.equal(continued.processedJobs, 2);
    const continuedRows = await db.select().from(jobs);
    assert.deepEqual(
      continuedRows.map((job) => job.status).sort(),
      [JobStatus.COMPLETED, JobStatus.FAILED].sort()
    );

    await db.delete(jobs);
    await admin.unsafe(`
      update "${schemaName}".pipeline_scheduler_state
      set reconciliation_cursor = 20
    `);
    await db.insert(jobs).values([
      { type: JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL, idempotencyKey: 'internal-first',
        payload: { sourceAssetId: 100, userId: 1 } },
      { type: JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL, idempotencyKey: 'cron-recovers',
        payload: { sourceAssetId: 100, userId: 1 } },
    ]);
    let followUpAttempts = 0;
    const processAndComplete = async (job: NonNullable<typeof activeJob>) => {
      await jobService.markJobCompleted(job.id, job.leaseToken!);
    };
    const internal = await processor.runPipelineProcessor({
      origin: 'internal',
      maxJobs: 1,
      processJob: processAndComplete,
      triggerFollowUp: () => {
        followUpAttempts += 1;
        throw new Error('deterministic trigger failure');
      },
    });
    assert.equal(internal.stopReason, 'max_jobs');
    assert.equal(internal.followUpTriggered, false);
    assert.equal(followUpAttempts, 1);
    await admin.unsafe(`
      update "${schemaName}".pipeline_scheduler_state
      set reconciliation_cursor = 20
    `);
    const cronRecovery = await processor.runPipelineProcessor({
      origin: 'cron',
      maxJobs: 1,
      processJob: processAndComplete,
      triggerFollowUp: () => {
        followUpAttempts += 1;
      },
    });
    assert.equal(cronRecovery.processedJobs, 1);
    assert.equal(cronRecovery.followUpTriggered, false);
    assert.equal(followUpAttempts, 1);

    await db.delete(jobs);
    await admin.unsafe(`update "${schemaName}".pipeline_scheduler_state set reconciliation_cursor = 20`);
    await db.insert(jobs).values({
      type: JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL,
      idempotencyKey: 'release-race',
      payload: { sourceAssetId: 100, userId: 1 },
    });
    const releaseEntered = deferred();
    const continueRelease = deferred();
    let releaseRaceFollowUps = 0;
    const releaseRaceProcessor = processor.runPipelineProcessor({
      origin: 'internal',
      maxJobs: 1,
      processJob: processAndComplete,
      releaseOwnership: async (ownerToken) => {
        releaseEntered.resolve();
        await continueRelease.promise;
        return await scheduler.releasePipelineProcessor(ownerToken);
      },
      triggerFollowUp: () => {
        releaseRaceFollowUps += 1;
      },
    });
    await releaseEntered.promise;
    const cursorAtTakeover = await admin.unsafe(`select reconciliation_cursor, reconciliation_cycle from "${schemaName}".pipeline_scheduler_state`);
    await admin.unsafe(`update "${schemaName}".pipeline_scheduler_state set lease_expires_at = clock_timestamp() - interval '1 second'`);
    const cleanupSuccessor = await scheduler.acquirePipelineProcessor({ ownerToken: 'cleanup-successor' });
    assert.ok(cleanupSuccessor);
    continueRelease.resolve();
    const releaseRace = await releaseRaceProcessor;
    assert.equal(releaseRace.stopReason, 'processor_busy');
    assert.equal(releaseRace.followUpTriggered, false);
    assert.equal(releaseRaceFollowUps, 0);
    const cursorAfterTakeover = await admin.unsafe(`select reconciliation_cursor, reconciliation_cycle from "${schemaName}".pipeline_scheduler_state`);
    assert.deepEqual(cursorAfterTakeover, cursorAtTakeover);
    await scheduler.releasePipelineProcessor(cleanupSuccessor.ownerToken);

    await db.delete(jobs);
    await admin.unsafe(`update "${schemaName}".pipeline_scheduler_state set reconciliation_cursor = 20`);
    await db.insert(jobs).values([
      { type: JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL, idempotencyKey: 'fatal-first',
        payload: { sourceAssetId: 100, userId: 1 } },
      { type: JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL, idempotencyKey: 'fatal-second',
        payload: { sourceAssetId: 100, userId: 1 } },
      { type: JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL, idempotencyKey: 'fatal-unclaimed',
        payload: { sourceAssetId: 100, userId: 1 } },
    ]);
    let fatalAttempts = 0;
    let fatalFollowUps = 0;
    const partialFatal = await processor.runPipelineProcessor({
      origin: 'internal',
      maxJobs: 3,
      processJob: async (job) => {
        fatalAttempts += 1;
        if (fatalAttempts === 1) {
          await jobService.markJobCompleted(job.id, job.leaseToken!);
          return;
        }
        throw new Error('deterministic infrastructure failure');
      },
      triggerFollowUp: () => {
        fatalFollowUps += 1;
      },
    });
    assert.equal(partialFatal.stopReason, 'fatal_error');
    assert.equal(partialFatal.processedJobs, 1);
    assert.equal(fatalAttempts, 2);
    assert.equal(fatalFollowUps, 0);
    const fatalRows = await db.select().from(jobs);
    assert.deepEqual(
      fatalRows.map((job) => job.status).sort(),
      [JobStatus.COMPLETED, JobStatus.PENDING, JobStatus.PROCESSING].sort()
    );

    await db.delete(jobs);
    await admin.unsafe(`
      delete from "${schemaName}".source_assets;
      delete from "${schemaName}".projects;
      update "${schemaName}".pipeline_scheduler_state
      set owner_token = null, lease_expires_at = null,
          reconciliation_cursor = null, reconciliation_cycle = 0
    `);
    const originalNodeEnv = process.env.NODE_ENV;
    const mutableEnv = process.env as unknown as Record<string, string | undefined>;
    const originalInternalSecret = process.env.INTERNAL_PROCESSING_SECRET;
    const originalCronSecret = process.env.CRON_SECRET;
    const internalRoute = await import('../../app/api/internal/jobs/process/route.ts');
    const cronRoute = await import('../../app/api/cron/process-jobs/route.ts');
    try {
      delete process.env.INTERNAL_PROCESSING_SECRET;
      let response = await internalRoute.POST(new Request('https://app.invalid/api/internal/jobs/process', {
        method: 'POST', headers: { authorization: 'Bearer missing' },
      }));
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: 'Pipeline processing failed.' });

      process.env.INTERNAL_PROCESSING_SECRET = 'internal-only-secret';
      response = await internalRoute.POST(new Request('https://app.invalid/api/internal/jobs/process', {
        method: 'POST', headers: { authorization: 'Bearer wrong' },
      }));
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: 'Unauthorized' });
      response = await internalRoute.POST(new Request('https://app.invalid/api/internal/jobs/process', {
        method: 'POST', headers: { authorization: 'Bearer internal-only-secret' },
      }));
      assert.equal(response.status, 200);

      mutableEnv.NODE_ENV = 'test';
      response = await cronRoute.GET(new Request('https://app.invalid/api/cron/process-jobs', {
        headers: { authorization: 'Bearer cron-only-secret' },
      }));
      assert.equal(response.status, 404);

      mutableEnv.NODE_ENV = 'production';
      delete process.env.CRON_SECRET;
      response = await cronRoute.GET(new Request('https://app.invalid/api/cron/process-jobs', {
        headers: { authorization: 'Bearer missing' },
      }));
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: 'Pipeline processing failed.' });
      process.env.CRON_SECRET = 'cron-only-secret';
      response = await cronRoute.GET(new Request('https://app.invalid/api/cron/process-jobs', {
        headers: { authorization: 'Bearer internal-only-secret' },
      }));
      assert.equal(response.status, 401);
      response = await cronRoute.GET(new Request('https://app.invalid/api/cron/process-jobs', {
        headers: { authorization: 'Bearer cron-only-secret' },
      }));
      assert.equal(response.status, 200);

      process.env.RENDER_TIMEOUT_MS = '780000';
      response = await internalRoute.POST(new Request('https://app.invalid/api/internal/jobs/process', {
        method: 'POST', headers: { authorization: 'Bearer internal-only-secret' },
      }));
      assert.equal(response.status, 500);
      const safeFatalBody = JSON.stringify(await response.json());
      assert.equal(safeFatalBody, JSON.stringify({ error: 'Pipeline processing failed.' }));
      assert.doesNotMatch(safeFatalBody, /internal-only-secret|render_clip|timeout/i);
    } finally {
      if (originalNodeEnv === undefined) delete mutableEnv.NODE_ENV;
      else mutableEnv.NODE_ENV = originalNodeEnv;
      if (originalInternalSecret === undefined) delete process.env.INTERNAL_PROCESSING_SECRET;
      else process.env.INTERNAL_PROCESSING_SECRET = originalInternalSecret;
      if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = originalCronSecret;
      delete process.env.RENDER_TIMEOUT_MS;
    }
  } finally {
    delete process.env.MAX_RENDER_CONCURRENCY;
    delete process.env.MAX_FACECAM_CONCURRENCY;
    if (appClient) await appClient.end();
    await admin.unsafe(`drop schema if exists "${schemaName}" cascade`);
    await admin.end();
  }
});
