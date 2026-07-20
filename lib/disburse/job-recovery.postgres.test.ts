import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { register } from 'node:module';
import test from 'node:test';
import postgres from 'postgres';

register('../test/typescript-path-loader.mjs', import.meta.url);

test('durable job recovery preserves canonical outcomes, resumes checkpoints, and serializes deletion races', {
  skip: !process.env.PHASE1A_TEST_DATABASE_URL,
}, async () => {
  const configuredUrl = process.env.PHASE1A_TEST_DATABASE_URL!;
  const parsed = new URL(configuredUrl);
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(parsed.hostname));
  assert.equal(parsed.pathname.replace(/^\//, ''), 'disburse_phase1a_test');

  const schemaName = `phase5_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(configuredUrl, { max: 8 });
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
    isolatedUrl.searchParams.set('application_name', `phase5_${schemaName}`);
    process.env.POSTGRES_URL = isolatedUrl.toString();

    const { client, db } = await import('../db/drizzle.ts');
    appClient = client;
    const schema = await import('../db/schema.ts');
    const recovery = await import('./job-recovery-service.ts');
    const pipeline = await import('./pipeline-service.ts');
    const { deleteProjectGraph } = await import('./media-retention-service.ts');
    const { eq } = await import('drizzle-orm');

    const [user] = await db.insert(schema.users).values({
      email: `phase5-${randomUUID()}@example.com`,
      passwordHash: 'test',
    }).returning();
    const [otherUser] = await db.insert(schema.users).values({
      email: `phase5-other-${randomUUID()}@example.com`,
      passwordHash: 'test',
    }).returning();

    async function createSourceGraph(label: string) {
      const [project] = await db.insert(schema.projects).values({
        userId: user.id,
        name: label,
        isSaved: true,
      }).returning();
      const [source] = await db.insert(schema.sourceAssets).values({
        userId: user.id,
        projectId: project.id,
        title: label,
        assetType: schema.SourceAssetType.UPLOADED_FILE,
        originalFilename: `${label}.mp4`,
        mimeType: 'video/mp4',
        storageKey: `${label}.mp4`,
        storageUrl: `storage://${label}.mp4`,
        status: schema.SourceAssetStatus.FAILED,
      }).returning();
      return { project, source };
    }

    const graph = await createSourceGraph('canonical');
    const [failed] = await db.insert(schema.jobs).values({
      type: schema.JobType.TRANSCRIBE_SOURCE_ASSET,
      status: schema.JobStatus.FAILED,
      idempotencyKey: `failed-${randomUUID()}`,
      payload: { sourceAssetId: graph.source.id, userId: user.id },
      attemptCount: 2,
      failureReason: 'Safe preparation failure.',
      failureCode: 'external_effect_not_started',
      failureClass: schema.JobFailureClass.SAFE_NO_EXTERNAL_EFFECT,
      completedAt: new Date(),
    }).returning();
    const request = {
      userId: user.id,
      jobId: failed.id,
      mode: schema.JobRecoveryMode.RETRY,
      idempotencyKey: `retry-${randomUUID()}`,
      requestedBy: 'user' as const,
    };
    const accepted = await recovery.requestJobRecovery(request);
    const duplicate = await recovery.requestJobRecovery(request);
    assert.equal(accepted.outcome, schema.JobRecoveryOutcome.ACCEPTED);
    assert.ok(accepted.successorJobId);
    assert.equal(duplicate.successorJobId, accepted.successorJobId);
    const persistedOriginal = await db.query.jobs.findFirst({ where: eq(schema.jobs.id, failed.id) });
    assert.equal(persistedOriginal?.status, schema.JobStatus.FAILED);
    assert.equal(persistedOriginal?.attemptCount, 2);

    const acceptedIdentity = recovery.buildRecoveryIdempotencyIdentity(request.idempotencyKey);
    const malformedReplayCases = [
      { code: 'invalid_body', jobId: failed.id, mode: schema.JobRecoveryMode.RETRY },
      { code: 'body_too_large', jobId: failed.id, mode: schema.JobRecoveryMode.RETRY },
      { code: 'invalid_request', jobId: null, mode: schema.JobRecoveryMode.RETRY },
      { code: 'invalid_request', jobId: failed.id, mode: 'invalid-mode' },
      { code: 'invalid_request', jobId: failed.id, mode: null, expectedCurrentGeneration: 'other-generation' },
    ];
    for (const replayCase of malformedReplayCases) {
      const conflict = await recovery.persistInvalidRecoveryRequest({
        idempotencyKey: request.idempotencyKey,
        userId: otherUser.id,
        jobId: replayCase.jobId,
        mode: replayCase.mode,
        expectedCurrentGeneration: replayCase.expectedCurrentGeneration,
        code: replayCase.code,
      });
      assert.deepEqual(conflict, {
        outcome: schema.JobRecoveryOutcome.REJECTED,
        code: 'idempotency_conflict',
        successorJobId: null,
        requestedJobId: null,
        canonical: false,
      });
    }
    const conflictEvents = await db.select().from(schema.jobRecoveryEvents).where(
      eq(schema.jobRecoveryEvents.requestIdentity, acceptedIdentity)
    );
    assert.equal(
      conflictEvents.filter((event) => event.eventType === 'conflict').every((event) => event.requestedJobId === null),
      true
    );

    const malformedFirstKey = `malformed-first-${randomUUID()}`;
    const malformedFirst = await recovery.persistInvalidRecoveryRequest({
      idempotencyKey: malformedFirstKey,
      userId: user.id,
      jobId: failed.id,
      mode: schema.JobRecoveryMode.RETRY,
      code: 'invalid_request',
    });
    const malformedDuplicate = await recovery.persistInvalidRecoveryRequest({
      idempotencyKey: malformedFirstKey,
      userId: user.id,
      jobId: failed.id,
      mode: schema.JobRecoveryMode.RETRY,
      code: 'invalid_request',
    });
    assert.deepEqual(malformedDuplicate, malformedFirst);
    const validAfterMalformed = await recovery.requestJobRecovery({
      ...request,
      idempotencyKey: malformedFirstKey,
    });
    assert.equal(validAfterMalformed.code, 'idempotency_conflict');
    assert.equal(validAfterMalformed.requestedJobId, null);
    assert.equal(validAfterMalformed.successorJobId, null);

    const [publish] = await db.insert(schema.jobs).values({
      type: schema.JobType.PUBLISH_RENDERED_CLIP,
      status: schema.JobStatus.FAILED,
      idempotencyKey: `publish-${randomUUID()}`,
      payload: { clipPublicationId: 1, renderedClipId: 1, linkedAccountId: 1, userId: user.id, platform: 'youtube' },
      failureCode: 'publish_failed',
      failureClass: schema.JobFailureClass.PERMANENT,
      completedAt: new Date(),
    }).returning();
    const rejected = await recovery.requestJobRecovery({
      userId: user.id,
      jobId: publish.id,
      mode: schema.JobRecoveryMode.RETRY,
      idempotencyKey: `publish-recovery-${randomUUID()}`,
      requestedBy: 'operator',
    });
    assert.equal(rejected.code, 'publishing_recovery_forbidden');
    assert.equal(rejected.outcome, schema.JobRecoveryOutcome.REJECTED);

    const prefix = 'x'.repeat(200);
    const malformedA = `${prefix}a`;
    const malformedB = `${prefix}b`;
    const validIdentity = recovery.buildRecoveryIdempotencyIdentity(prefix);
    const malformedAIdentity = recovery.buildRecoveryIdempotencyIdentity(malformedA);
    const malformedBIdentity = recovery.buildRecoveryIdempotencyIdentity(malformedB);
    assert.match(validIdentity, /^recovery-id:v1:valid:[a-f0-9]{64}$/);
    assert.match(malformedAIdentity, /^recovery-id:v1:malformed:201:201:[a-f0-9]{64}$/);
    assert.notEqual(validIdentity, malformedAIdentity);
    assert.notEqual(malformedAIdentity, malformedBIdentity);
    assert.equal(recovery.buildRecoveryIdempotencyIdentity(malformedA), malformedAIdentity);
    const unicodeMalformed = '🎮'.repeat(201);
    assert.match(
      recovery.buildRecoveryIdempotencyIdentity(unicodeMalformed),
      /^recovery-id:v1:malformed:201:804:[a-f0-9]{64}$/
    );
    const malformedDerivedAsValid = recovery.buildRecoveryIdempotencyIdentity(malformedAIdentity);
    const validDerivedAsValid = recovery.buildRecoveryIdempotencyIdentity(validIdentity);
    assert.match(malformedDerivedAsValid, /^recovery-id:v1:valid:[a-f0-9]{64}$/);
    assert.match(validDerivedAsValid, /^recovery-id:v1:valid:[a-f0-9]{64}$/);
    assert.notEqual(malformedDerivedAsValid, malformedAIdentity);
    assert.notEqual(validDerivedAsValid, validIdentity);

    await recovery.persistInvalidRecoveryRequest({
      idempotencyKey: malformedA,
      code: 'invalid_request',
    });
    await recovery.persistInvalidRecoveryRequest({
      idempotencyKey: malformedB,
      code: 'invalid_request',
    });
    await recovery.persistInvalidRecoveryRequest({
      idempotencyKey: prefix,
      code: 'invalid_request',
    });
    const reversePrefix = 'y'.repeat(200);
    await recovery.persistInvalidRecoveryRequest({
      idempotencyKey: reversePrefix,
      code: 'invalid_request',
    });
    await recovery.persistInvalidRecoveryRequest({
      idempotencyKey: `${reversePrefix}z`,
      code: 'invalid_request',
    });
    const malformedRows = await db.select().from(schema.jobRecoveryRequests);
    assert.equal(new Set(malformedRows.map((row) => row.idempotencyIdentity)).size, malformedRows.length);
    assert.equal(malformedRows.some((row) => row.idempotencyIdentity === prefix), false);
    assert.equal(malformedRows.some((row) => row.idempotencyIdentity === malformedA), false);

    const resumeGraph = await createSourceGraph('resume');
    const [variant] = await db.insert(schema.sourceAssetThumbnailVariants).values({
      sourceAssetId: resumeGraph.source.id,
      variant: 'preview',
      storageKey: 'resume-thumbnail.jpg',
      mimeType: 'image/jpeg',
      width: 640,
      height: 360,
    }).returning();
    const [checkpointed] = await db.insert(schema.jobs).values({
      type: schema.JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL,
      status: schema.JobStatus.FAILED,
      idempotencyKey: `checkpoint-${randomUUID()}`,
      payload: { sourceAssetId: resumeGraph.source.id, userId: user.id },
      failureCode: 'durable_checkpoint_available',
      failureClass: schema.JobFailureClass.DURABLE_CHECKPOINT,
      completedAt: new Date(),
    }).returning();
    await db.insert(schema.jobEffectCheckpoints).values({
      jobId: checkpointed.id,
      effectKey: 'primary_external_effect_v1',
      jobType: schema.JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL,
      status: schema.JobEffectCheckpointStatus.COMPLETED,
      result: {
        jobType: schema.JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL,
        sourceAssetId: resumeGraph.source.id,
        thumbnailVariantId: variant.id,
        persistedAt: new Date().toISOString(),
      },
      completedAt: new Date(),
    });
    const resume = await recovery.requestJobRecovery({
      userId: user.id,
      jobId: checkpointed.id,
      mode: schema.JobRecoveryMode.RESUME,
      idempotencyKey: `resume-${randomUUID()}`,
      requestedBy: 'user',
    });
    assert.ok(resume.successorJobId);
    const leaseToken = randomUUID();
    const [claimedResume] = await db.update(schema.jobs).set({
      status: schema.JobStatus.PROCESSING,
      leaseToken,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      startedAt: new Date(),
    }).where(eq(schema.jobs.id, resume.successorJobId!)).returning();
    let providerCalls = 0;
    const runtime = {
      ...pipeline.productionPipelineProcessingRuntime,
      processors: {
        ...pipeline.productionPipelineProcessingRuntime.processors,
        extractThumbnail: async () => {
          providerCalls += 1;
          throw new Error('resume must not call provider');
        },
      },
      downstream: { trigger: () => undefined },
      timer: { startHeartbeat: () => null, stopHeartbeat: () => undefined },
    };
    const processed = await pipeline.processClaimedJob(claimedResume as never, runtime);
    assert.equal(processed.status, 'completed');
    assert.equal(providerCalls, 0);

    function deferred() {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      return { promise, resolve };
    }
    async function waitForBlockedLifecycleQueries(minimum: number) {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const [row] = await admin<{ count: number }[]>`
          select count(*)::int as count from pg_stat_activity
          where application_name = ${`phase5_${schemaName}`}
            and wait_event_type = 'Lock'
        `;
        if (row.count >= minimum) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('Timed out forcing recovery/deletion lock order.');
    }
    async function forceLifecycleOrder(first: 'recovery' | 'deletion') {
      const orderedGraph = await createSourceGraph(`forced-${first}`);
      const [orderedJob] = await db.insert(schema.jobs).values({
        type: schema.JobType.TRANSCRIBE_SOURCE_ASSET,
        status: schema.JobStatus.FAILED,
        idempotencyKey: `forced-job-${randomUUID()}`,
        payload: { sourceAssetId: orderedGraph.source.id, userId: user.id },
        failureCode: 'external_effect_not_started',
        failureClass: schema.JobFailureClass.SAFE_NO_EXTERNAL_EFFECT,
        completedAt: new Date(),
      }).returning();
      const blockerUrl = new URL(isolatedUrl);
      blockerUrl.searchParams.set('application_name', `phase5_blocker_${first}`);
      const blocker = postgres(blockerUrl.toString(), { max: 1 });
      const entered = deferred();
      const release = deferred();
      const blocked = blocker.begin(async (tx) => {
        await tx`select id from projects where id = ${orderedGraph.project.id} for update`;
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const recover = () => recovery.requestJobRecovery({
        userId: user.id,
        jobId: orderedJob.id,
        mode: schema.JobRecoveryMode.RETRY,
        idempotencyKey: `forced-request-${first}-${randomUUID()}`,
        requestedBy: 'user',
      });
      const remove = () => deleteProjectGraph({
        projectId: orderedGraph.project.id,
        userId: user.id,
        deleteStorageObject: async () => undefined,
      });
      const firstPromise = first === 'recovery' ? recover() : remove();
      await waitForBlockedLifecycleQueries(1);
      const secondPromise = first === 'recovery' ? remove() : recover();
      await waitForBlockedLifecycleQueries(2);
      release.resolve();
      await blocked;
      const outcomes = await Promise.allSettled([firstPromise, secondPromise]);
      await blocker.end();
      assert.equal(outcomes.every((outcome) => outcome.status === 'fulfilled'), true);
    }

    await forceLifecycleOrder('recovery');
    await forceLifecycleOrder('deletion');

    for (let iteration = 0; iteration < 5; iteration += 1) {
      const raceGraph = await createSourceGraph(`race-${iteration}`);
      const [raceJob] = await db.insert(schema.jobs).values({
        type: schema.JobType.TRANSCRIBE_SOURCE_ASSET,
        status: schema.JobStatus.FAILED,
        idempotencyKey: `race-job-${randomUUID()}`,
        payload: { sourceAssetId: raceGraph.source.id, userId: user.id },
        failureCode: 'external_effect_not_started',
        failureClass: schema.JobFailureClass.SAFE_NO_EXTERNAL_EFFECT,
        completedAt: new Date(),
      }).returning();
      const outcomes = await Promise.allSettled([
        recovery.requestJobRecovery({
          userId: user.id,
          jobId: raceJob.id,
          mode: schema.JobRecoveryMode.RETRY,
          idempotencyKey: `race-request-${randomUUID()}`,
          requestedBy: 'user',
        }),
        deleteProjectGraph({
          projectId: raceGraph.project.id,
          userId: user.id,
          deleteStorageObject: async () => undefined,
        }),
      ]);
      assert.equal(outcomes.every((outcome) => outcome.status === 'fulfilled'), true);
    }
  } finally {
    if (appClient) await appClient.end();
    await admin.unsafe(`drop schema if exists "${schemaName}" cascade`);
    await admin.end();
  }
});
