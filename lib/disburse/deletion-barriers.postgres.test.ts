import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { register } from 'node:module';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';

register('../test/typescript-path-loader.mjs', import.meta.url);

test('deletion barriers preserve graphs until cancellation and storage cleanup complete', {
  skip: !process.env.PHASE1A_TEST_DATABASE_URL,
}, async () => {
  const configuredUrl = process.env.PHASE1A_TEST_DATABASE_URL!;
  const parsed = new URL(configuredUrl);
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(parsed.hostname));
  assert.equal(parsed.pathname.replace(/^\//, ''), 'disburse_phase1a_test');

  const schemaName = `deletion_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(configuredUrl, { max: 1 });
  let appClient: { end: () => Promise<void> } | undefined;
  let blocker: ReturnType<typeof postgres> | undefined;
  let observer: ReturnType<typeof postgres> | undefined;

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
        const scopedStatement = statement
          .trim()
          .replaceAll('"public".', `"${schemaName}".`);
        if (scopedStatement) await admin.unsafe(scopedStatement);
      }
    }

    const isolatedUrl = new URL(configuredUrl);
    isolatedUrl.searchParams.set('options', `-csearch_path=${schemaName}`);
    const applicationName = `phase2_${schemaName}`;
    isolatedUrl.searchParams.set('application_name', applicationName);
    process.env.POSTGRES_URL = isolatedUrl.toString();

    const blockerUrl = new URL(isolatedUrl);
    blockerUrl.searchParams.set('application_name', `${applicationName}_blocker`);
    const observerUrl = new URL(isolatedUrl);
    observerUrl.searchParams.set('application_name', `${applicationName}_observer`);
    const blockerClient = postgres(blockerUrl.toString(), { max: 1 });
    const observerClient = postgres(observerUrl.toString(), { max: 1 });
    blocker = blockerClient;
    observer = observerClient;

    const { client, db } = await import('../db/drizzle.ts');
    appClient = client;
    const schema = await import('../db/schema.ts');
    const {
      deleteProjectGraph,
      deleteSourceAssetGraph,
    } = await import('./media-retention-service.ts');
    const {
      enqueueTranscriptionJob,
      heartbeatJobLease,
    } = await import('./job-service.ts');
    const { ensureShortFormContentPack } = await import('./short-form-service.ts');
    const { extractSourceAssetThumbnail } = await import('./source-asset-thumbnail-service.ts');
    const { uploadStorageObject } = await import('./s3-storage.ts');
    const {
      claimSourceUploadSessionForCompletion,
      completeSourceUploadSessionAtomically,
      createProductionSourceAssetUploadService,
    } = await import('./source-asset-upload-service.ts');
    const { SourceUploadCompletionInProgressError } =
      await import('./source-asset-upload-service-core.ts');
    const { LifecycleMutationBlockedError } = await import('./lifecycle-mutation-barrier.ts');

    const deferred = <T = void>() => {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      return { promise, resolve, reject };
    };

    const waitForBlockedAppQueries = async (minimum: number) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const [row] = await observerClient<{ count: number }[]>`
          select count(*)::int as count
          from pg_stat_activity
          where application_name = ${applicationName}
            and wait_event_type = 'Lock'
        `;
        if (row.count >= minimum) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for ${minimum} blocked lifecycle queries.`);
    };

    const holdLifecycleLocks = async (projectId: number, sourceAssetId?: number) => {
      const locked = deferred();
      const release = deferred();
      const done = blockerClient.begin(async (tx) => {
        await tx`select id from projects where id = ${projectId} for update`;
        if (sourceAssetId) {
          await tx`select id from source_assets where id = ${sourceAssetId} for update`;
        }
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      return { release: () => release.resolve(), done };
    };

    const [user] = await db.insert(schema.users).values({
      email: `phase2-${randomUUID()}@example.com`,
      passwordHash: 'test',
    }).returning();

    const createSource = async (name: string, projectId?: number) => {
      const project = projectId
        ? (await db.select().from(schema.projects)
            .where(eq(schema.projects.id, projectId)))[0]!
        : (await db.insert(schema.projects).values({
            userId: user.id,
            name,
            isSaved: true,
          }).returning())[0]!;
      const [sourceAsset] = await db.insert(schema.sourceAssets).values({
        userId: user.id,
        projectId: project.id,
        title: `${name} source`,
        assetType: schema.SourceAssetType.UPLOADED_FILE,
        mimeType: 'video/mp4',
        storageKey: `${name}/source.mp4`,
        storageUrl: `storage://${name}/source.mp4`,
        thumbnailStorageKey: `${name}/thumbnail.jpg`,
        status: schema.SourceAssetStatus.READY,
      }).returning();
      await db.insert(schema.sourceAssetThumbnailVariants).values({
        sourceAssetId: sourceAsset.id,
        variant: 'preview',
        storageKey: `${name}/thumbnail-preview.jpg`,
        mimeType: 'image/jpeg',
        width: 640,
        height: 360,
      });
      return { project, sourceAsset };
    };

    const createCompletableUpload = async (projectId: number, name: string) => {
      const fileSizeBytes = 5 * 1024 * 1024;
      const [session] = await db.insert(schema.sourceUploadSessions).values({
        userId: user.id,
        projectId,
        idempotencyKey: `${name}-${randomUUID()}`,
        originalFilename: `${name}.mp4`,
        mimeType: 'video/mp4',
        fileSizeBytes,
        storageKey: `uploads/${name}-${randomUUID()}.mp4`,
        uploadId: `${name}-upload`,
        partSizeBytes: fileSizeBytes,
        totalParts: 1,
        status: schema.SourceUploadSessionStatus.UPLOADING,
      }).returning();
      await db.insert(schema.sourceUploadParts).values({
        uploadSessionId: session.id,
        partNumber: 1,
        byteStart: 0,
        byteEnd: fileSizeBytes - 1,
        sizeBytes: fileSizeBytes,
        etag: '"part-1"',
        status: schema.SourceUploadPartStatus.UPLOADED,
      });
      return session;
    };

    const lifecycle = await createSource('lifecycle');
    const [transcript] = await db.insert(schema.transcripts).values({
      userId: user.id,
      sourceAssetId: lifecycle.sourceAsset.id,
      content: 'Grounded transcript',
      status: schema.TranscriptStatus.READY,
    }).returning();
    const generationRunId = randomUUID();
    const [contentPack] = await db.insert(schema.contentPacks).values({
      userId: user.id,
      projectId: lifecycle.project.id,
      sourceAssetId: lifecycle.sourceAsset.id,
      transcriptId: transcript.id,
      kind: schema.ContentPackKind.SHORT_FORM_CLIPS,
      name: 'clips',
      generationRunId,
    }).returning();
    const [candidate] = await db.insert(schema.clipCandidates).values({
      userId: user.id,
      contentPackId: contentPack.id,
      sourceAssetId: lifecycle.sourceAsset.id,
      transcriptId: transcript.id,
      rank: 1,
      startTimeMs: 0,
      endTimeMs: 30_000,
      durationMs: 30_000,
      hook: 'Hook',
      title: 'Title',
      captionCopy: 'Caption',
      summary: 'Summary',
      transcriptExcerpt: 'Excerpt',
      whyItWorks: 'Reason',
      platformFit: 'Short form',
      confidence: 90,
      generationRunId,
    }).returning();
    const [renderedClip] = await db.insert(schema.renderedClips).values({
      userId: user.id,
      contentPackId: contentPack.id,
      sourceAssetId: lifecycle.sourceAsset.id,
      clipCandidateId: candidate.id,
      generationRunId,
      title: 'Rendered',
      startTimeMs: 0,
      endTimeMs: 30_000,
      durationMs: 30_000,
      storageKey: 'lifecycle/rendered.mp4',
    }).returning();
    const [linkedAccount] = await db.insert(schema.linkedAccounts).values({
      userId: user.id,
      platform: 'youtube',
      platformAccountId: randomUUID(),
      accessToken: 'mock-token',
    }).returning();
    const [publication] = await db.insert(schema.clipPublications).values({
      userId: user.id,
      renderedClipId: renderedClip.id,
      linkedAccountId: linkedAccount.id,
      platform: 'youtube',
    }).returning();

    const jobPayloads = [
      { type: schema.JobType.TRANSCRIBE_SOURCE_ASSET, payload: { sourceAssetId: lifecycle.sourceAsset.id, userId: user.id } },
      { type: schema.JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL, payload: { sourceAssetId: lifecycle.sourceAsset.id, userId: user.id } },
      { type: schema.JobType.INGEST_YOUTUBE_SOURCE_ASSET, payload: { sourceAssetId: lifecycle.sourceAsset.id, userId: user.id } },
      { type: schema.JobType.GENERATE_SHORT_FORM_PACK, payload: { sourceAssetId: lifecycle.sourceAsset.id, contentPackId: contentPack.id, userId: user.id, generationRunId } },
      { type: schema.JobType.RENDER_CLIP_CANDIDATE, payload: { sourceAssetId: lifecycle.sourceAsset.id, contentPackId: contentPack.id, clipCandidateId: candidate.id, userId: user.id, generationRunId } },
      { type: schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM, payload: { sourceAssetId: lifecycle.sourceAsset.id, contentPackId: contentPack.id, clipCandidateId: candidate.id, userId: user.id, generationRunId } },
      { type: schema.JobType.DETECT_CLIP_FACECAM, payload: { sourceAssetId: lifecycle.sourceAsset.id, contentPackId: contentPack.id, clipCandidateId: candidate.id, userId: user.id, generationRunId, startTimeMs: 0, endTimeMs: 30_000, detectorVersion: 'facecam_v1', detectionRunId: 1 } },
      { type: schema.JobType.PUBLISH_RENDERED_CLIP, payload: { clipPublicationId: publication.id, renderedClipId: renderedClip.id, linkedAccountId: linkedAccount.id, userId: user.id, platform: 'youtube' } },
    ];
    await db.insert(schema.jobs).values(jobPayloads.map(({ type, payload }, index) => ({
      type,
      status: schema.JobStatus.PENDING,
      idempotencyKey: `phase2:all-types:${index}:${randomUUID()}`,
      payload: payload as never,
    })));

    const attemptedStorageKeys = new Set<string>();
    await assert.rejects(deleteProjectGraph({
      projectId: lifecycle.project.id,
      userId: user.id,
      deleteStorageObject: async (storageKey) => {
        attemptedStorageKeys.add(storageKey);
        if (storageKey.endsWith('rendered.mp4')) throw new Error('mock storage unavailable');
      },
    }), /mock storage unavailable/);
    assert.deepEqual(attemptedStorageKeys, new Set([
      'lifecycle/source.mp4',
      'lifecycle/thumbnail.jpg',
      'lifecycle/thumbnail-preview.jpg',
      'lifecycle/rendered.mp4',
      `uploads/source-asset-thumbnails/${user.id}/${lifecycle.project.id}/${lifecycle.sourceAsset.id}/default.jpg`,
      `uploads/source-asset-thumbnails/${user.id}/${lifecycle.project.id}/${lifecycle.sourceAsset.id}/default.webp`,
    ]));
    assert.ok(await db.query.projects.findFirst({
      where: (row, { eq }) => eq(row.id, lifecycle.project.id),
    }));
    assert.ok(await db.query.renderedClips.findFirst({
      where: (row, { eq }) => eq(row.id, renderedClip.id),
    }));
    const cancelledRelatedJobs = await db.query.jobs.findMany({
      where: (row, { like }) => like(row.idempotencyKey, 'phase2:all-types:%'),
    });
    assert.equal(cancelledRelatedJobs.length, 8);
    assert.ok(cancelledRelatedJobs.every((job) =>
      job.status === schema.JobStatus.CANCELLED &&
      job.cancellationReason === 'project_deleted' &&
      job.cancellationRequestedAt
    ));

    const retryStorageKeys: string[] = [];
    const retried = await deleteProjectGraph({
      projectId: lifecycle.project.id,
      userId: user.id,
      deleteStorageObject: async (storageKey) => { retryStorageKeys.push(storageKey); },
    });
    assert.equal(retried.deleted, true);
    assert.equal(retryStorageKeys.length, 6);
    assert.equal(await db.query.projects.findFirst({
      where: (row, { eq }) => eq(row.id, lifecycle.project.id),
    }), undefined);
    const repeated = await deleteProjectGraph({
      projectId: lifecycle.project.id,
      userId: user.id,
      deleteStorageObject: async () => { throw new Error('must not run'); },
    });
    assert.equal(repeated.deleted, false);

    const leased = await createSource('leased');
    const [leasedJob] = await db.insert(schema.jobs).values({
      type: schema.JobType.TRANSCRIBE_SOURCE_ASSET,
      status: schema.JobStatus.PROCESSING,
      idempotencyKey: `phase2:leased:${randomUUID()}`,
      payload: { sourceAssetId: leased.sourceAsset.id, userId: user.id },
      leaseToken: 'active-token',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    }).returning();
    const pending = await deleteProjectGraph({
      projectId: leased.project.id,
      userId: user.id,
      deleteStorageObject: async () => undefined,
    });
    assert.equal(pending.pending, true);
    assert.equal(await heartbeatJobLease(leasedJob.id, 'active-token'), false);
    assert.ok(await db.query.projects.findFirst({
      where: (row, { eq }) => eq(row.id, leased.project.id),
    }));
    await db.update(schema.jobs).set({ leaseExpiresAt: new Date(0) })
      .where(eq(schema.jobs.id, leasedJob.id));
    const finalizedLease = await deleteProjectGraph({
      projectId: leased.project.id,
      userId: user.id,
      deleteStorageObject: async () => undefined,
    });
    assert.equal(finalizedLease.deleted, true);
    const terminalLease = await db.query.jobs.findFirst({
      where: (row, { eq }) => eq(row.id, leasedJob.id),
    });
    assert.equal(terminalLease!.status, schema.JobStatus.CANCELLED);

    const sourceOnly = await createSource('source-only');
    await db.insert(schema.jobs).values({
      type: schema.JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL,
      idempotencyKey: `phase2:source-thumbnail:${randomUUID()}`,
      payload: { sourceAssetId: sourceOnly.sourceAsset.id, userId: user.id },
    });
    const deletedSource = await deleteSourceAssetGraph({
      projectId: sourceOnly.project.id,
      sourceAssetId: sourceOnly.sourceAsset.id,
      userId: user.id,
      deleteStorageObject: async () => undefined,
    });
    assert.equal(deletedSource.deleted, true);
    assert.equal(await db.query.sourceAssets.findFirst({
      where: (row, { eq }) => eq(row.id, sourceOnly.sourceAsset.id),
    }), undefined);

    const [contentionProject] = await db.insert(schema.projects).values({
      userId: user.id,
      name: 'completion-contention',
      isSaved: true,
    }).returning();
    const contentionSession = await createCompletableUpload(
      contentionProject.id,
      'completion-contention'
    );
    const contentionExternalStarted = deferred();
    const releaseContentionExternal = deferred();
    const contentionWaiterObserved = deferred();
    const releaseContentionWaiter = deferred();
    const contentionNotifications: number[] = [];
    const contentionThumbnailJobs: number[] = [];
    let contentionExternalCalls = 0;
    const contentionIntegrations = {
      listMultipartUploadParts: async () => [{ partNumber: 1, etag: '"part-1"' }],
      completeMultipartUpload: async () => {
        contentionExternalCalls += 1;
        contentionExternalStarted.resolve();
        await releaseContentionExternal.promise;
      },
      createUploadCompletedNotification: async (sourceAssetId: number) => {
        contentionNotifications.push(sourceAssetId);
      },
      enqueueThumbnailJob: async (sourceAssetId: number) => {
        contentionThumbnailJobs.push(sourceAssetId);
        return null;
      },
    };
    const contentionOwnerService = createProductionSourceAssetUploadService(
      contentionIntegrations
    );
    const contentionWaiterService = createProductionSourceAssetUploadService({
      ...contentionIntegrations,
      waitForCompletionStateChange: async () => {
        contentionWaiterObserved.resolve();
        await releaseContentionWaiter.promise;
      },
    });
    const contentionOwner = contentionOwnerService.completeSourceAssetUpload({
      uploadSessionId: contentionSession.id,
      title: 'Contended source',
    }, user);
    await contentionExternalStarted.promise;
    const contentionWaiter = contentionWaiterService.completeSourceAssetUpload({
      uploadSessionId: contentionSession.id,
      title: 'Contended source',
    }, user);
    await contentionWaiterObserved.promise;
    releaseContentionExternal.resolve();
    const contentionOwnerResult = await contentionOwner;
    releaseContentionWaiter.resolve();
    const contentionWaiterResult = await contentionWaiter;
    assert.equal(
      contentionWaiterResult.sourceAsset.id,
      contentionOwnerResult.sourceAsset.id
    );
    assert.equal(contentionExternalCalls, 1);
    assert.deepEqual(contentionNotifications, [contentionOwnerResult.sourceAsset.id]);
    assert.deepEqual(contentionThumbnailJobs, [contentionOwnerResult.sourceAsset.id]);

    const [timeoutProject] = await db.insert(schema.projects).values({
      userId: user.id,
      name: 'completion-timeout',
      isSaved: true,
    }).returning();
    const timeoutSession = await createCompletableUpload(timeoutProject.id, 'completion-timeout');
    const timeoutExternalStarted = deferred();
    const releaseTimeoutExternal = deferred();
    let timeoutExternalCalls = 0;
    const timeoutOwnerService = createProductionSourceAssetUploadService({
      listMultipartUploadParts: async () => [{ partNumber: 1, etag: '"part-1"' }],
      completeMultipartUpload: async () => {
        timeoutExternalCalls += 1;
        timeoutExternalStarted.resolve();
        await releaseTimeoutExternal.promise;
      },
      createUploadCompletedNotification: async () => undefined,
      enqueueThumbnailJob: async () => null,
    });
    let timeoutNow = Date.now();
    const timeoutWaiterService = createProductionSourceAssetUploadService({
      now: () => new Date(timeoutNow),
      completionWaitTimeoutMs: 100,
      completionPollIntervalMs: 25,
      waitForCompletionStateChange: async (milliseconds) => {
        timeoutNow += milliseconds;
      },
      listMultipartUploadParts: async () => { throw new Error('must not inspect storage'); },
      completeMultipartUpload: async () => { throw new Error('must not complete storage'); },
      createUploadCompletedNotification: async () => { throw new Error('must not notify'); },
      enqueueThumbnailJob: async () => { throw new Error('must not enqueue'); },
    });
    const timeoutOwner = timeoutOwnerService.completeSourceAssetUpload({
      uploadSessionId: timeoutSession.id,
      title: 'Timeout source',
    }, user);
    await timeoutExternalStarted.promise;
    await assert.rejects(
      timeoutWaiterService.completeSourceAssetUpload({
        uploadSessionId: timeoutSession.id,
        title: 'Timeout source',
      }, user),
      (error: unknown) => error instanceof SourceUploadCompletionInProgressError
    );
    releaseTimeoutExternal.resolve();
    const timeoutOwnerResult = await timeoutOwner;
    const timeoutRetry = await timeoutWaiterService.completeSourceAssetUpload({
      uploadSessionId: timeoutSession.id,
      title: 'Timeout source',
    }, user);
    assert.equal(timeoutRetry.sourceAsset.id, timeoutOwnerResult.sourceAsset.id);
    assert.equal(timeoutExternalCalls, 1);

    const [failureProject] = await db.insert(schema.projects).values({
      userId: user.id,
      name: 'completion-failure-contention',
      isSaved: true,
    }).returning();
    const failureSession = await createCompletableUpload(
      failureProject.id,
      'completion-failure-contention'
    );
    const failureExternalStarted = deferred();
    const releaseFailureExternal = deferred();
    const failureWaiterObserved = deferred();
    const releaseFailureWaiter = deferred();
    let failureListCalls = 0;
    let failureExternalCalls = 0;
    const failureOwnerService = createProductionSourceAssetUploadService({
      listMultipartUploadParts: async () => {
        failureListCalls += 1;
        return [{ partNumber: 1, etag: '"part-1"' }];
      },
      completeMultipartUpload: async () => {
        failureExternalCalls += 1;
        failureExternalStarted.resolve();
        await releaseFailureExternal.promise;
        throw new Error('Storage completion result is unknown.');
      },
    });
    const failureWaiterService = createProductionSourceAssetUploadService({
      waitForCompletionStateChange: async () => {
        failureWaiterObserved.resolve();
        await releaseFailureWaiter.promise;
      },
      listMultipartUploadParts: async () => {
        failureListCalls += 1;
        return [];
      },
      completeMultipartUpload: async () => { failureExternalCalls += 1; },
    });
    const failureOwner = failureOwnerService.completeSourceAssetUpload({
      uploadSessionId: failureSession.id,
      title: 'Failure source',
    }, user);
    await failureExternalStarted.promise;
    const failureWaiter = failureWaiterService.completeSourceAssetUpload({
      uploadSessionId: failureSession.id,
      title: 'Failure source',
    }, user);
    await failureWaiterObserved.promise;
    releaseFailureExternal.resolve();
    await assert.rejects(failureOwner, /result is unknown/i);
    releaseFailureWaiter.resolve();
    await assert.rejects(failureWaiter, /storage state/i);
    assert.equal(failureListCalls, 2);
    assert.equal(failureExternalCalls, 1);
    assert.equal(await db.query.sourceAssets.findFirst({
      where: (row, { eq }) => eq(row.storageKey, failureSession.storageKey),
    }), undefined);
    assert.equal((await db.query.sourceUploadSessions.findFirst({
      where: (row, { eq }) => eq(row.id, failureSession.id),
    }))!.status, schema.SourceUploadSessionStatus.FAILED);

    const [atomicProject] = await db.insert(schema.projects).values({
      userId: user.id,
      name: 'atomic-completion',
      isSaved: true,
    }).returning();
    const atomicSession = await createCompletableUpload(atomicProject.id, 'atomic-completion');
    const atomicBeforeCommit = deferred();
    const releaseAtomicCommit = deferred();
    const atomicCleanupStarted = deferred();
    const releaseAtomicCleanup = deferred();
    const atomicNotifications: number[] = [];
    const atomicThumbnailJobs: number[] = [];
    let uncommittedSourceAssetId = 0;
    let atomicMultipartAbortCalls = 0;
    const atomicCompletionService = createProductionSourceAssetUploadService({
      listMultipartUploadParts: async () => [{ partNumber: 1, etag: '"part-1"' }],
      completeMultipartUpload: async () => undefined,
      completeUploadSessionWithSourceAsset: async (input) =>
        await completeSourceUploadSessionAtomically(input, async (sourceAsset) => {
          uncommittedSourceAssetId = sourceAsset!.id;
          atomicBeforeCommit.resolve();
          await releaseAtomicCommit.promise;
        }),
      createUploadCompletedNotification: async (sourceAssetId) => {
        atomicNotifications.push(sourceAssetId);
      },
      enqueueThumbnailJob: async (sourceAssetId) => {
        atomicThumbnailJobs.push(sourceAssetId);
        return null;
      },
    });
    const atomicCompletion = atomicCompletionService.completeSourceAssetUpload({
      uploadSessionId: atomicSession.id,
      title: 'Atomic source',
    }, user);
    await atomicBeforeCommit.promise;
    const [uncommittedVisibility] = await observerClient<{
      source_count: number;
      status: string;
      source_asset_id: number | null;
    }[]>`
      select
        (select count(*)::int from source_assets where storage_key = ${atomicSession.storageKey}) as source_count,
        status,
        source_asset_id
      from source_upload_sessions
      where id = ${atomicSession.id}
    `;
    assert.deepEqual(uncommittedVisibility, {
      source_count: 0,
      status: schema.SourceUploadSessionStatus.COMPLETING,
      source_asset_id: null,
    });
    const atomicDeletion = deleteSourceAssetGraph({
      projectId: atomicProject.id,
      sourceAssetId: uncommittedSourceAssetId,
      userId: user.id,
      abortMultipartUpload: async () => { atomicMultipartAbortCalls += 1; },
      deleteStorageObject: async () => {
        atomicCleanupStarted.resolve();
        await releaseAtomicCleanup.promise;
      },
    });
    await waitForBlockedAppQueries(1);
    releaseAtomicCommit.resolve();
    const completedAtomicUpload = await atomicCompletion;
    await atomicCleanupStarted.promise;
    const [committedVisibility] = await observerClient<{
      source_count: number;
      status: string;
      source_asset_id: number | null;
    }[]>`
      select
        (select count(*)::int from source_assets where id = ${completedAtomicUpload.sourceAsset.id}) as source_count,
        status,
        source_asset_id
      from source_upload_sessions
      where id = ${atomicSession.id}
    `;
    assert.deepEqual(committedVisibility, {
      source_count: 1,
      status: schema.SourceUploadSessionStatus.COMPLETED,
      source_asset_id: completedAtomicUpload.sourceAsset.id,
    });
    const repeatedAtomicUpload = await atomicCompletionService.completeSourceAssetUpload({
      uploadSessionId: atomicSession.id,
      title: 'Atomic source',
    }, user);
    assert.equal(repeatedAtomicUpload.sourceAsset.id, completedAtomicUpload.sourceAsset.id);
    assert.deepEqual(atomicNotifications, [completedAtomicUpload.sourceAsset.id]);
    assert.deepEqual(atomicThumbnailJobs, [completedAtomicUpload.sourceAsset.id]);
    releaseAtomicCleanup.resolve();
    assert.equal((await atomicDeletion).deleted, true);
    assert.equal(atomicMultipartAbortCalls, 0);

    const [intentWinsProject] = await db.insert(schema.projects).values({
      userId: user.id,
      name: 'completion-intent-wins',
      isSaved: true,
    }).returning();
    const intentWinsSession = await createCompletableUpload(
      intentWinsProject.id,
      'completion-intent-wins'
    );
    const externalCompletionStarted = deferred();
    const releaseExternalCompletion = deferred();
    const intentWaiterObserved = deferred();
    const releaseIntentWaiter = deferred();
    const intentWinsNotifications: number[] = [];
    const intentWinsThumbnailJobs: number[] = [];
    let intentWinsExternalCalls = 0;
    const intentWinsCompletionService = createProductionSourceAssetUploadService({
      listMultipartUploadParts: async () => [{ partNumber: 1, etag: '"part-1"' }],
      completeMultipartUpload: async () => {
        intentWinsExternalCalls += 1;
        externalCompletionStarted.resolve();
        await releaseExternalCompletion.promise;
      },
      createUploadCompletedNotification: async (sourceAssetId) => {
        intentWinsNotifications.push(sourceAssetId);
      },
      enqueueThumbnailJob: async (sourceAssetId) => {
        intentWinsThumbnailJobs.push(sourceAssetId);
        return null;
      },
    });
    const intentWinsWaiterService = createProductionSourceAssetUploadService({
      listMultipartUploadParts: async () => { throw new Error('must not restart completion'); },
      completeMultipartUpload: async () => { intentWinsExternalCalls += 1; },
      waitForCompletionStateChange: async () => {
        intentWaiterObserved.resolve();
        await releaseIntentWaiter.promise;
      },
      createUploadCompletedNotification: async (sourceAssetId) => {
        intentWinsNotifications.push(sourceAssetId);
      },
      enqueueThumbnailJob: async (sourceAssetId) => {
        intentWinsThumbnailJobs.push(sourceAssetId);
        return null;
      },
    });
    const completionAfterIntent = intentWinsCompletionService.completeSourceAssetUpload({
      uploadSessionId: intentWinsSession.id,
      title: 'Must not exist',
    }, user).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error })
    );
    await externalCompletionStarted.promise;
    const intentWinsWaiter = intentWinsWaiterService.completeSourceAssetUpload({
      uploadSessionId: intentWinsSession.id,
      title: 'Must not exist',
    }, user).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error })
    );
    await intentWaiterObserved.promise;
    let intentWinsStorageCalls = 0;
    assert.equal((await deleteProjectGraph({
      projectId: intentWinsProject.id,
      userId: user.id,
      abortMultipartUpload: async () => undefined,
      deleteStorageObject: async () => { intentWinsStorageCalls += 1; },
    })).pending, true);
    assert.equal(intentWinsStorageCalls, 0);
    releaseExternalCompletion.resolve();
    assert.match(String((await completionAfterIntent).error), /deleting project/i);
    releaseIntentWaiter.resolve();
    assert.match(String((await intentWinsWaiter).error), /delet/i);
    assert.equal(intentWinsExternalCalls, 1);
    assert.equal(await db.query.sourceAssets.findFirst({
      where: (row, { eq }) => eq(row.storageKey, intentWinsSession.storageKey),
    }), undefined);
    const failedIntentSession = await db.query.sourceUploadSessions.findFirst({
      where: (row, { eq }) => eq(row.id, intentWinsSession.id),
    });
    assert.equal(failedIntentSession!.status, schema.SourceUploadSessionStatus.FAILED);
    assert.equal(failedIntentSession!.sourceAssetId, null);
    assert.deepEqual(intentWinsNotifications, []);
    assert.deepEqual(intentWinsThumbnailJobs, []);
    const intentWinsAbortIds: string[] = [];
    assert.equal((await deleteProjectGraph({
      projectId: intentWinsProject.id,
      userId: user.id,
      abortMultipartUpload: async ({ uploadId }) => { intentWinsAbortIds.push(uploadId); },
      deleteStorageObject: async () => undefined,
    })).deleted, true);
    assert.deepEqual(intentWinsAbortIds, [intentWinsSession.uploadId]);

    const anomalousCompleting = await createSource('anomalous-completing');
    const [anomalousSession] = await db.insert(schema.sourceUploadSessions).values({
      userId: user.id,
      projectId: anomalousCompleting.project.id,
      idempotencyKey: randomUUID(),
      originalFilename: 'anomalous.mp4',
      mimeType: 'video/mp4',
      fileSizeBytes: 10,
      storageKey: anomalousCompleting.sourceAsset.storageKey!,
      uploadId: 'anomalous-completing',
      partSizeBytes: 5,
      totalParts: 2,
      status: schema.SourceUploadSessionStatus.COMPLETING,
      sourceAssetId: null,
    }).returning();
    let anomalousStorageCalls = 0;
    let anomalousAbortCalls = 0;
    assert.equal((await deleteSourceAssetGraph({
      projectId: anomalousCompleting.project.id,
      sourceAssetId: anomalousCompleting.sourceAsset.id,
      userId: user.id,
      abortMultipartUpload: async () => { anomalousAbortCalls += 1; },
      deleteStorageObject: async () => { anomalousStorageCalls += 1; },
    })).pending, true);
    assert.equal(anomalousStorageCalls, 0);
    assert.equal(anomalousAbortCalls, 0);
    assert.ok(await db.query.sourceAssets.findFirst({
      where: (row, { eq }) => eq(row.id, anomalousCompleting.sourceAsset.id),
    }));
    assert.ok(await db.query.sourceUploadSessions.findFirst({
      where: (row, { eq }) => eq(row.id, anomalousSession.id),
    }));

    const [otherUser] = await db.insert(schema.users).values({
      email: `phase2-isolation-${randomUUID()}@example.com`,
      passwordHash: 'test',
    }).returning();

    const differentUserSource = await createSource('different-user-isolation');
    const [differentUserSession] = await db.insert(schema.sourceUploadSessions).values({
      userId: otherUser.id,
      projectId: differentUserSource.project.id,
      idempotencyKey: randomUUID(),
      originalFilename: 'different-user.mp4',
      mimeType: 'video/mp4',
      fileSizeBytes: 10,
      storageKey: differentUserSource.sourceAsset.storageKey!,
      uploadId: 'different-user-completing',
      partSizeBytes: 5,
      totalParts: 2,
      status: schema.SourceUploadSessionStatus.COMPLETING,
    }).returning();
    assert.equal((await deleteSourceAssetGraph({
      projectId: differentUserSource.project.id,
      sourceAssetId: differentUserSource.sourceAsset.id,
      userId: user.id,
      abortMultipartUpload: async () => { throw new Error('must not abort different user'); },
      deleteStorageObject: async () => undefined,
    })).deleted, true);
    assert.ok(await db.query.sourceUploadSessions.findFirst({
      where: (row, { eq }) => eq(row.id, differentUserSession.id),
    }));

    const differentProjectSource = await createSource('different-project-isolation');
    const [otherProject] = await db.insert(schema.projects).values({
      userId: user.id,
      name: 'other project',
      isSaved: true,
    }).returning();
    const [otherProjectSession] = await db.insert(schema.sourceUploadSessions).values({
      userId: user.id,
      projectId: otherProject.id,
      idempotencyKey: randomUUID(),
      originalFilename: 'other-project.mp4',
      mimeType: 'video/mp4',
      fileSizeBytes: 10,
      storageKey: differentProjectSource.sourceAsset.storageKey!,
      uploadId: 'other-project-completing',
      partSizeBytes: 5,
      totalParts: 2,
      status: schema.SourceUploadSessionStatus.COMPLETING,
    }).returning();
    assert.equal((await deleteSourceAssetGraph({
      projectId: differentProjectSource.project.id,
      sourceAssetId: differentProjectSource.sourceAsset.id,
      userId: user.id,
      abortMultipartUpload: async () => { throw new Error('must not abort different project'); },
      deleteStorageObject: async () => undefined,
    })).deleted, true);
    assert.ok(await db.query.sourceUploadSessions.findFirst({
      where: (row, { eq }) => eq(row.id, otherProjectSession.id),
    }));

    const differentKeySource = await createSource('different-key-isolation');
    const [differentKeySession] = await db.insert(schema.sourceUploadSessions).values({
      userId: user.id,
      projectId: differentKeySource.project.id,
      idempotencyKey: randomUUID(),
      originalFilename: 'different-key.mp4',
      mimeType: 'video/mp4',
      fileSizeBytes: 10,
      storageKey: `uploads/different-${randomUUID()}.mp4`,
      uploadId: 'different-key-completing',
      partSizeBytes: 5,
      totalParts: 2,
      status: schema.SourceUploadSessionStatus.COMPLETING,
    }).returning();
    assert.equal((await deleteSourceAssetGraph({
      projectId: differentKeySource.project.id,
      sourceAssetId: differentKeySource.sourceAsset.id,
      userId: user.id,
      abortMultipartUpload: async () => { throw new Error('must not abort different key'); },
      deleteStorageObject: async () => undefined,
    })).deleted, true);
    assert.ok(await db.query.sourceUploadSessions.findFirst({
      where: (row, { eq }) => eq(row.id, differentKeySession.id),
    }));

    const [nullKeyProject] = await db.insert(schema.projects).values({
      userId: user.id,
      name: 'null-key-isolation',
      isSaved: true,
    }).returning();
    const [nullKeySource] = await db.insert(schema.sourceAssets).values({
      userId: user.id,
      projectId: nullKeyProject.id,
      title: 'Null key source',
      assetType: schema.SourceAssetType.PASTED_TRANSCRIPT,
      storageKey: null,
      storageUrl: 'storage://null-key',
      status: schema.SourceAssetStatus.READY,
    }).returning();
    const [nullKeyUnlinkedSession] = await db.insert(schema.sourceUploadSessions).values({
      userId: user.id,
      projectId: nullKeyProject.id,
      idempotencyKey: randomUUID(),
      originalFilename: 'null-key.mp4',
      mimeType: 'video/mp4',
      fileSizeBytes: 10,
      storageKey: `uploads/null-key-${randomUUID()}.mp4`,
      uploadId: 'null-key-unlinked',
      partSizeBytes: 5,
      totalParts: 2,
      status: schema.SourceUploadSessionStatus.COMPLETING,
    }).returning();
    assert.equal((await deleteSourceAssetGraph({
      projectId: nullKeyProject.id,
      sourceAssetId: nullKeySource.id,
      userId: user.id,
      abortMultipartUpload: async () => { throw new Error('must not abort null fallback'); },
      deleteStorageObject: async () => undefined,
    })).deleted, true);
    assert.ok(await db.query.sourceUploadSessions.findFirst({
      where: (row, { eq }) => eq(row.id, nullKeyUnlinkedSession.id),
    }));

    const [linkedNullSource] = await db.insert(schema.sourceAssets).values({
      userId: user.id,
      projectId: nullKeyProject.id,
      title: 'Linked null source',
      assetType: schema.SourceAssetType.PASTED_TRANSCRIPT,
      storageKey: null,
      storageUrl: 'storage://linked-null',
      status: schema.SourceAssetStatus.READY,
    }).returning();
    const [linkedNullSession] = await db.insert(schema.sourceUploadSessions).values({
      userId: user.id,
      projectId: nullKeyProject.id,
      idempotencyKey: randomUUID(),
      originalFilename: 'linked-null.mp4',
      mimeType: 'video/mp4',
      fileSizeBytes: 10,
      storageKey: `uploads/linked-null-${randomUUID()}.mp4`,
      uploadId: 'linked-null',
      partSizeBytes: 5,
      totalParts: 2,
      status: schema.SourceUploadSessionStatus.COMPLETING,
      sourceAssetId: linkedNullSource.id,
    }).returning();
    assert.equal((await deleteSourceAssetGraph({
      projectId: nullKeyProject.id,
      sourceAssetId: linkedNullSource.id,
      userId: user.id,
      abortMultipartUpload: async () => { throw new Error('must not abort completing link'); },
      deleteStorageObject: async () => { throw new Error('must not delete completing link'); },
    })).pending, true);
    assert.ok(await db.query.sourceUploadSessions.findFirst({
      where: (row, { eq }) => eq(row.id, linkedNullSession.id),
    }));

    const [emptyKeyProject] = await db.insert(schema.projects).values({
      userId: user.id,
      name: 'empty-key-isolation',
      isSaved: true,
    }).returning();
    const [emptyKeySource] = await db.insert(schema.sourceAssets).values({
      userId: user.id,
      projectId: emptyKeyProject.id,
      title: 'Empty key source',
      assetType: schema.SourceAssetType.PASTED_TRANSCRIPT,
      storageKey: '',
      storageUrl: 'storage://empty-key',
      status: schema.SourceAssetStatus.READY,
    }).returning();
    const [emptyKeyUnlinkedSession] = await db.insert(schema.sourceUploadSessions).values({
      userId: user.id,
      projectId: emptyKeyProject.id,
      idempotencyKey: randomUUID(),
      originalFilename: 'empty-key.mp4',
      mimeType: 'video/mp4',
      fileSizeBytes: 10,
      storageKey: '',
      uploadId: 'empty-key-unlinked',
      partSizeBytes: 5,
      totalParts: 2,
      status: schema.SourceUploadSessionStatus.COMPLETING,
    }).returning();
    assert.equal((await deleteSourceAssetGraph({
      projectId: emptyKeyProject.id,
      sourceAssetId: emptyKeySource.id,
      userId: user.id,
      abortMultipartUpload: async () => { throw new Error('must not abort empty fallback'); },
      deleteStorageObject: async () => undefined,
    })).deleted, true);
    assert.ok(await db.query.sourceUploadSessions.findFirst({
      where: (row, { eq }) => eq(row.id, emptyKeyUnlinkedSession.id),
    }));

    const [linkedEmptySource] = await db.insert(schema.sourceAssets).values({
      userId: user.id,
      projectId: emptyKeyProject.id,
      title: 'Linked empty source',
      assetType: schema.SourceAssetType.PASTED_TRANSCRIPT,
      storageKey: '',
      storageUrl: 'storage://linked-empty',
      status: schema.SourceAssetStatus.READY,
    }).returning();
    const [linkedEmptySession] = await db.insert(schema.sourceUploadSessions).values({
      userId: user.id,
      projectId: emptyKeyProject.id,
      idempotencyKey: randomUUID(),
      originalFilename: 'linked-empty.mp4',
      mimeType: 'video/mp4',
      fileSizeBytes: 10,
      storageKey: `uploads/linked-empty-${randomUUID()}.mp4`,
      uploadId: 'linked-empty',
      partSizeBytes: 5,
      totalParts: 2,
      status: schema.SourceUploadSessionStatus.COMPLETING,
      sourceAssetId: linkedEmptySource.id,
    }).returning();
    assert.equal((await deleteSourceAssetGraph({
      projectId: emptyKeyProject.id,
      sourceAssetId: linkedEmptySource.id,
      userId: user.id,
      abortMultipartUpload: async () => { throw new Error('must not abort completing link'); },
      deleteStorageObject: async () => { throw new Error('must not delete completing link'); },
    })).pending, true);
    assert.ok(await db.query.sourceUploadSessions.findFirst({
      where: (row, { eq }) => eq(row.id, linkedEmptySession.id),
    }));

    const deduplicatedSessionSource = await createSource('deduplicated-session');
    const [deduplicatedSession] = await db.insert(schema.sourceUploadSessions).values({
      userId: user.id,
      projectId: deduplicatedSessionSource.project.id,
      idempotencyKey: randomUUID(),
      originalFilename: 'deduplicated.mp4',
      mimeType: 'video/mp4',
      fileSizeBytes: 10,
      storageKey: deduplicatedSessionSource.sourceAsset.storageKey!,
      uploadId: 'deduplicated-upload',
      partSizeBytes: 5,
      totalParts: 2,
      status: schema.SourceUploadSessionStatus.UPLOADING,
      sourceAssetId: deduplicatedSessionSource.sourceAsset.id,
    }).returning();
    let deduplicatedAbortCalls = 0;
    assert.equal((await deleteSourceAssetGraph({
      projectId: deduplicatedSessionSource.project.id,
      sourceAssetId: deduplicatedSessionSource.sourceAsset.id,
      userId: user.id,
      abortMultipartUpload: async () => { deduplicatedAbortCalls += 1; },
      deleteStorageObject: async () => undefined,
    })).deleted, true);
    assert.equal(deduplicatedAbortCalls, 1);
    assert.equal(await db.query.sourceUploadSessions.findFirst({
      where: (row, { eq }) => eq(row.id, deduplicatedSession.id),
    }), undefined);

    const repeatedConcurrent = await createSource('repeated-concurrent');
    const repeatedLock = await holdLifecycleLocks(
      repeatedConcurrent.project.id,
      repeatedConcurrent.sourceAsset.id
    );
    const firstRepeatedDeletion = deleteProjectGraph({
      projectId: repeatedConcurrent.project.id,
      userId: user.id,
      deleteStorageObject: async () => undefined,
    });
    await waitForBlockedAppQueries(1);
    const secondRepeatedDeletion = deleteProjectGraph({
      projectId: repeatedConcurrent.project.id,
      userId: user.id,
      deleteStorageObject: async () => undefined,
    });
    await waitForBlockedAppQueries(2);
    repeatedLock.release();
    await repeatedLock.done;
    const repeatedResults = await Promise.all([
      firstRepeatedDeletion,
      secondRepeatedDeletion,
    ]);
    assert.ok(repeatedResults.some((result) => result.deleted));
    assert.equal(await db.query.projects.findFirst({
      where: (row, { eq }) => eq(row.id, repeatedConcurrent.project.id),
    }), undefined);

    const enqueueWins = await createSource('enqueue-wins');
    const enqueueLock = await holdLifecycleLocks(
      enqueueWins.project.id,
      enqueueWins.sourceAsset.id
    );
    const enqueuedBeforeDeletion = enqueueTranscriptionJob(
      enqueueWins.sourceAsset.id,
      user.id
    );
    await waitForBlockedAppQueries(1);
    const deletionAfterEnqueue = deleteProjectGraph({
      projectId: enqueueWins.project.id,
      userId: user.id,
      deleteStorageObject: async () => undefined,
    });
    await waitForBlockedAppQueries(2);
    enqueueLock.release();
    await enqueueLock.done;
    const queuedJob = await enqueuedBeforeDeletion;
    assert.ok(queuedJob);
    assert.equal((await deletionAfterEnqueue).deleted, true);
    assert.equal((await db.query.jobs.findFirst({
      where: (row, { eq }) => eq(row.id, queuedJob.id),
    }))!.status, schema.JobStatus.CANCELLED);

    const deletionWins = await createSource('deletion-wins');
    await db.insert(schema.jobs).values({
      type: schema.JobType.TRANSCRIBE_SOURCE_ASSET,
      status: schema.JobStatus.PROCESSING,
      idempotencyKey: `phase2:deletion-wins:${randomUUID()}`,
      payload: { sourceAssetId: deletionWins.sourceAsset.id, userId: user.id },
      leaseToken: 'deletion-wins-token',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const deletionWinsLock = await holdLifecycleLocks(
      deletionWins.project.id,
      deletionWins.sourceAsset.id
    );
    const deletionBeforePack = deleteSourceAssetGraph({
      projectId: deletionWins.project.id,
      sourceAssetId: deletionWins.sourceAsset.id,
      userId: user.id,
      deleteStorageObject: async () => undefined,
    });
    await waitForBlockedAppQueries(1);
    const packAfterDeletion = ensureShortFormContentPack({
      projectId: deletionWins.project.id,
      sourceAssetId: deletionWins.sourceAsset.id,
      userId: user.id,
    }).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error })
    );
    await waitForBlockedAppQueries(2);
    deletionWinsLock.release();
    await deletionWinsLock.done;
    assert.equal((await deletionBeforePack).pending, true);
    assert.ok((await packAfterDeletion).error instanceof LifecycleMutationBlockedError);
    assert.equal(await db.query.contentPacks.findFirst({
      where: (row, { eq }) => eq(row.sourceAssetId, deletionWins.sourceAsset.id),
    }), undefined);

    const packWins = await createSource('pack-wins');
    const packWinsLock = await holdLifecycleLocks(packWins.project.id, packWins.sourceAsset.id);
    const packBeforeDeletion = ensureShortFormContentPack({
      projectId: packWins.project.id,
      sourceAssetId: packWins.sourceAsset.id,
      userId: user.id,
    });
    await waitForBlockedAppQueries(1);
    const deletionAfterPack = deleteSourceAssetGraph({
      projectId: packWins.project.id,
      sourceAssetId: packWins.sourceAsset.id,
      userId: user.id,
      deleteStorageObject: async () => undefined,
    }).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error })
    );
    await waitForBlockedAppQueries(2);
    packWinsLock.release();
    await packWinsLock.done;
    assert.equal((await packBeforeDeletion).sourceAssetId, packWins.sourceAsset.id);
    assert.match(String((await deletionAfterPack).error), /content pack/i);
    assert.equal((await db.query.sourceAssets.findFirst({
      where: (row, { eq }) => eq(row.id, packWins.sourceAsset.id),
    }))!.deletionRequestedAt, null);

    const uploadBlocked = await createSource('upload-blocked');
    await db.insert(schema.jobs).values({
      type: schema.JobType.TRANSCRIBE_SOURCE_ASSET,
      status: schema.JobStatus.PROCESSING,
      idempotencyKey: `phase2:upload-blocked:${randomUUID()}`,
      payload: { sourceAssetId: uploadBlocked.sourceAsset.id, userId: user.id },
      leaseToken: 'upload-blocked-token',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const [uploadSession] = await db.insert(schema.sourceUploadSessions).values({
      userId: user.id,
      projectId: uploadBlocked.project.id,
      idempotencyKey: randomUUID(),
      originalFilename: 'upload.mp4',
      mimeType: 'video/mp4',
      fileSizeBytes: 10,
      storageKey: `uploads/${randomUUID()}.mp4`,
      uploadId: randomUUID(),
      partSizeBytes: 5,
      totalParts: 2,
      status: schema.SourceUploadSessionStatus.UPLOADING,
    }).returning();
    let blockedUploadStorageCalls = 0;
    const uploadGateLock = await holdLifecycleLocks(uploadBlocked.project.id);
    const deletionBeforeUploadTransition = deleteProjectGraph({
      projectId: uploadBlocked.project.id,
      userId: user.id,
      deleteStorageObject: async () => { blockedUploadStorageCalls += 1; },
    });
    await waitForBlockedAppQueries(1);
    const uploadTransitionAfterDeletion = claimSourceUploadSessionForCompletion(
      uploadSession.id,
      user.id,
      new Date()
    ).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error })
    );
    await waitForBlockedAppQueries(2);
    uploadGateLock.release();
    await uploadGateLock.done;
    assert.equal((await deletionBeforeUploadTransition).pending, true);
    assert.ok(
      (await uploadTransitionAfterDeletion).error instanceof LifecycleMutationBlockedError
    );
    assert.equal(blockedUploadStorageCalls, 0);
    assert.equal((await db.query.sourceUploadSessions.findFirst({
      where: (row, { eq }) => eq(row.id, uploadSession.id),
    }))!.status, schema.SourceUploadSessionStatus.UPLOADING);

    const initiationDeletionWins = await createSource('initiation-deletion-wins');
    const deletionWinsMultipartCreated = deferred();
    const deletionWinsMultipartAborts: string[] = [];
    const deletionWinsUploadService = createProductionSourceAssetUploadService({
      createStorageKey: () => 'uploads/initiation-deletion-wins.mp4',
      createMultipartUpload: async () => {
        deletionWinsMultipartCreated.resolve();
        return { uploadId: 'multipart-deletion-wins' };
      },
      abortMultipartUpload: async ({ uploadId }) => {
        deletionWinsMultipartAborts.push(uploadId);
      },
    });
    const initiationDeletionWinsLock = await holdLifecycleLocks(
      initiationDeletionWins.project.id
    );
    const deletionBeforeInitiationInsert = deleteProjectGraph({
      projectId: initiationDeletionWins.project.id,
      userId: user.id,
      abortMultipartUpload: async () => undefined,
      deleteStorageObject: async () => undefined,
    });
    await waitForBlockedAppQueries(1);
    const insertionAfterDeletion = deletionWinsUploadService.initiateSourceAssetUpload({
      projectId: initiationDeletionWins.project.id,
      filename: 'video.mp4',
      mimeType: 'video/mp4',
      fileSizeBytes: 5 * 1024 * 1024,
      idempotencyKey: `deletion-wins-${randomUUID()}`,
    }, user).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error })
    );
    await deletionWinsMultipartCreated.promise;
    await waitForBlockedAppQueries(2);
    initiationDeletionWinsLock.release();
    await initiationDeletionWinsLock.done;
    assert.equal((await deletionBeforeInitiationInsert).deleted, true);
    assert.ok((await insertionAfterDeletion).error instanceof Error);
    assert.deepEqual(deletionWinsMultipartAborts, ['multipart-deletion-wins']);
    assert.equal(await db.query.sourceUploadSessions.findFirst({
      where: (row, { eq }) => eq(row.projectId, initiationDeletionWins.project.id),
    }), undefined);

    const initiationInsertWins = await createSource('initiation-insert-wins');
    const insertWinsMultipartCreated = deferred();
    const insertWinsCompensationAborts: string[] = [];
    const insertWinsDeletionAborts: string[] = [];
    const insertWinsUploadService = createProductionSourceAssetUploadService({
      createStorageKey: () => 'uploads/initiation-insert-wins.mp4',
      createMultipartUpload: async () => {
        insertWinsMultipartCreated.resolve();
        return { uploadId: 'multipart-insert-wins' };
      },
      abortMultipartUpload: async ({ uploadId }) => {
        insertWinsCompensationAborts.push(uploadId);
      },
    });
    const initiationInsertWinsLock = await holdLifecycleLocks(initiationInsertWins.project.id);
    const insertionBeforeDeletion = insertWinsUploadService.initiateSourceAssetUpload({
      projectId: initiationInsertWins.project.id,
      filename: 'video.mp4',
      mimeType: 'video/mp4',
      fileSizeBytes: 5 * 1024 * 1024,
      idempotencyKey: `insert-wins-${randomUUID()}`,
    }, user);
    await insertWinsMultipartCreated.promise;
    await waitForBlockedAppQueries(1);
    const deletionAfterInitiationInsert = deleteProjectGraph({
      projectId: initiationInsertWins.project.id,
      userId: user.id,
      abortMultipartUpload: async ({ uploadId }) => {
        insertWinsDeletionAborts.push(uploadId);
      },
      deleteStorageObject: async () => undefined,
    });
    await waitForBlockedAppQueries(2);
    initiationInsertWinsLock.release();
    await initiationInsertWinsLock.done;
    assert.equal((await insertionBeforeDeletion).session.status, schema.SourceUploadSessionStatus.UPLOADING);
    assert.equal((await deletionAfterInitiationInsert).deleted, true);
    assert.deepEqual(insertWinsCompensationAborts, []);
    assert.deepEqual(insertWinsDeletionAborts, ['multipart-insert-wins']);

    const incompleteUploads = await createSource('incomplete-uploads');
    await db.insert(schema.sourceUploadSessions).values([
      {
        userId: user.id,
        projectId: incompleteUploads.project.id,
        idempotencyKey: randomUUID(),
        originalFilename: 'uploading.mp4',
        mimeType: 'video/mp4',
        fileSizeBytes: 10,
        storageKey: 'uploads/incomplete-uploading.mp4',
        uploadId: 'incomplete-uploading',
        partSizeBytes: 5,
        totalParts: 2,
        status: schema.SourceUploadSessionStatus.UPLOADING,
      },
      {
        userId: user.id,
        projectId: incompleteUploads.project.id,
        idempotencyKey: randomUUID(),
        originalFilename: 'failed.mp4',
        mimeType: 'video/mp4',
        fileSizeBytes: 10,
        storageKey: 'uploads/incomplete-failed.mp4',
        uploadId: 'incomplete-failed',
        partSizeBytes: 5,
        totalParts: 2,
        status: schema.SourceUploadSessionStatus.FAILED,
      },
    ]);
    const incompleteAbortOrder: string[] = [];
    assert.equal((await deleteProjectGraph({
      projectId: incompleteUploads.project.id,
      userId: user.id,
      abortMultipartUpload: async ({ uploadId }) => {
        incompleteAbortOrder.push(uploadId);
      },
      deleteStorageObject: async () => undefined,
    })).deleted, true);
    assert.deepEqual(new Set(incompleteAbortOrder), new Set([
      'incomplete-uploading',
      'incomplete-failed',
    ]));

    const failedMultipartAbort = await createSource('failed-multipart-abort');
    const [retryableSession] = await db.insert(schema.sourceUploadSessions).values({
      userId: user.id,
      projectId: failedMultipartAbort.project.id,
      idempotencyKey: randomUUID(),
      originalFilename: 'retry.mp4',
      mimeType: 'video/mp4',
      fileSizeBytes: 10,
      storageKey: 'uploads/retry-abort.mp4',
      uploadId: 'retry-abort',
      partSizeBytes: 5,
      totalParts: 2,
      status: schema.SourceUploadSessionStatus.UPLOADING,
    }).returning();
    let abortAttempt = 0;
    let retryableStorageCalls = 0;
    await assert.rejects(deleteProjectGraph({
      projectId: failedMultipartAbort.project.id,
      userId: user.id,
      abortMultipartUpload: async () => {
        abortAttempt += 1;
        throw new Error('mock multipart abort unavailable');
      },
      deleteStorageObject: async () => { retryableStorageCalls += 1; },
    }), /mock multipart abort unavailable/);
    assert.equal(retryableStorageCalls, 0);
    assert.ok(await db.query.sourceUploadSessions.findFirst({
      where: (row, { eq }) => eq(row.id, retryableSession.id),
    }));
    assert.equal((await deleteProjectGraph({
      projectId: failedMultipartAbort.project.id,
      userId: user.id,
      abortMultipartUpload: async () => { abortAttempt += 1; },
      deleteStorageObject: async () => undefined,
    })).deleted, true);
    assert.equal(abortAttempt, 2);

    const completingUpload = await createSource('completing-upload');
    await db.insert(schema.sourceUploadSessions).values({
      userId: user.id,
      projectId: completingUpload.project.id,
      idempotencyKey: randomUUID(),
      originalFilename: 'completing.mp4',
      mimeType: 'video/mp4',
      fileSizeBytes: 10,
      storageKey: `uploads/${randomUUID()}.mp4`,
      uploadId: randomUUID(),
      partSizeBytes: 5,
      totalParts: 2,
      status: schema.SourceUploadSessionStatus.COMPLETING,
    });
    let completingStorageCalls = 0;
    assert.equal((await deleteProjectGraph({
      projectId: completingUpload.project.id,
      userId: user.id,
      deleteStorageObject: async () => { completingStorageCalls += 1; },
    })).pending, true);
    assert.equal(completingStorageCalls, 0);

    const clearedProjectIntent = await createSource('cleared-project-intent');
    const [projectIntentLease] = await db.insert(schema.jobs).values({
      type: schema.JobType.TRANSCRIBE_SOURCE_ASSET,
      status: schema.JobStatus.PROCESSING,
      idempotencyKey: `phase2:project-intent:${randomUUID()}`,
      payload: { sourceAssetId: clearedProjectIntent.sourceAsset.id, userId: user.id },
      leaseToken: 'project-intent-token',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    }).returning();
    assert.equal((await deleteProjectGraph({
      projectId: clearedProjectIntent.project.id,
      userId: user.id,
      deleteStorageObject: async () => undefined,
    })).pending, true);
    await assert.rejects(
      db.update(schema.projects).set({ deletionRequestedAt: null })
        .where(eq(schema.projects.id, clearedProjectIntent.project.id)),
      /cannot be cleared once set/
    );
    await db.update(schema.jobs).set({ leaseExpiresAt: new Date(0) })
      .where(eq(schema.jobs.id, projectIntentLease.id));
    assert.equal((await deleteProjectGraph({
      projectId: clearedProjectIntent.project.id,
      userId: user.id,
      deleteStorageObject: async () => undefined,
    })).deleted, true);

    const clearedSourceIntent = await createSource('cleared-source-intent');
    const [sourceIntentLease] = await db.insert(schema.jobs).values({
      type: schema.JobType.TRANSCRIBE_SOURCE_ASSET,
      status: schema.JobStatus.PROCESSING,
      idempotencyKey: `phase2:source-intent:${randomUUID()}`,
      payload: { sourceAssetId: clearedSourceIntent.sourceAsset.id, userId: user.id },
      leaseToken: 'source-intent-token',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    }).returning();
    assert.equal((await deleteSourceAssetGraph({
      projectId: clearedSourceIntent.project.id,
      sourceAssetId: clearedSourceIntent.sourceAsset.id,
      userId: user.id,
      deleteStorageObject: async () => undefined,
    })).pending, true);
    await assert.rejects(
      db.update(schema.sourceAssets).set({ deletionRequestedAt: null })
        .where(eq(schema.sourceAssets.id, clearedSourceIntent.sourceAsset.id)),
      /cannot be cleared once set/
    );
    await db.update(schema.jobs).set({ leaseExpiresAt: new Date(0) })
      .where(eq(schema.jobs.id, sourceIntentLease.id));
    assert.equal((await deleteSourceAssetGraph({
      projectId: clearedSourceIntent.project.id,
      sourceAssetId: clearedSourceIntent.sourceAsset.id,
      userId: user.id,
      deleteStorageObject: async () => undefined,
    })).deleted, true);

    const thumbnailRace = await createSource('thumbnail-race');
    const [thumbnailJob] = await db.insert(schema.jobs).values({
      type: schema.JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL,
      status: schema.JobStatus.PROCESSING,
      idempotencyKey: `phase2:thumbnail-race:${randomUUID()}`,
      payload: { sourceAssetId: thumbnailRace.sourceAsset.id, userId: user.id },
      leaseToken: 'thumbnail-token',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    }).returning();
    const uploadStarted = deferred();
    const releaseUpload = deferred();
    let uploadedThumbnailKey = '';
    let deliveredUploadSignal: AbortSignal | undefined;
    const thumbnailObjects = new Set<string>();
    const thumbnailAuthorityController = new AbortController();
    const thumbnailWork = extractSourceAssetThumbnail(
      thumbnailRace.sourceAsset.id,
      user.id,
      {
        jobId: thumbnailJob.id,
        leaseToken: 'thumbnail-token',
        signal: thumbnailAuthorityController.signal,
      },
      {
        createDownload: () => ({ method: 'GET', downloadUrl: 'https://mock.invalid/source' }),
        extractFrame: async () => undefined,
        readImageDimensions: async () => ({ width: 640, height: 360 }),
        readFile: (async () => Buffer.from('thumbnail')) as never,
        uploadStorageObject: async ({ storageKey, signal }) => {
          uploadedThumbnailKey = storageKey;
          deliveredUploadSignal = signal;
          uploadStarted.resolve();
          await releaseUpload.promise;
          thumbnailObjects.add(storageKey);
          return `storage://${storageKey}`;
        },
        deleteStorageObject: async (storageKey) => {
          thumbnailObjects.delete(storageKey);
        },
      }
    ).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error })
    );
    await uploadStarted.promise;
    await db.update(schema.jobs).set({ leaseExpiresAt: new Date(0) })
      .where(eq(schema.jobs.id, thumbnailJob.id));
    assert.equal((await deleteProjectGraph({
      projectId: thumbnailRace.project.id,
      userId: user.id,
      deleteStorageObject: async (storageKey) => {
        thumbnailObjects.delete(storageKey);
      },
    })).deleted, true);
    releaseUpload.resolve();
    assert.match(String((await thumbnailWork).error), /not authorized/i);
    assert.equal(deliveredUploadSignal, thumbnailAuthorityController.signal);
    assert.equal(thumbnailObjects.has(uploadedThumbnailKey), false);
    assert.equal(await db.query.projects.findFirst({
      where: (row, { eq }) => eq(row.id, thumbnailRace.project.id),
    }), undefined);

    const thumbnailTakeover = await createSource('thumbnail-takeover');
    const [takeoverJob] = await db.insert(schema.jobs).values({
      type: schema.JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL,
      status: schema.JobStatus.PROCESSING,
      idempotencyKey: `phase2:thumbnail-takeover:${randomUUID()}`,
      payload: { sourceAssetId: thumbnailTakeover.sourceAsset.id, userId: user.id },
      leaseToken: 'stale-thumbnail-token',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    }).returning();
    const takeoverObjects = new Set<string>();
    let takeoverCompensationCalls = 0;
    const takeoverWork = extractSourceAssetThumbnail(
      thumbnailTakeover.sourceAsset.id,
      user.id,
      { jobId: takeoverJob.id, leaseToken: 'stale-thumbnail-token' },
      {
        createDownload: () => ({ method: 'GET', downloadUrl: 'https://mock.invalid/source' }),
        extractFrame: async () => undefined,
        readImageDimensions: async () => ({ width: 640, height: 360 }),
        readFile: (async () => Buffer.from('thumbnail')) as never,
        uploadStorageObject: async ({ storageKey }) => {
          takeoverObjects.add(storageKey);
          await db.insert(schema.sourceAssetThumbnailVariants).values({
            sourceAssetId: thumbnailTakeover.sourceAsset.id,
            variant: 'default',
            storageKey,
            mimeType: 'image/jpeg',
            width: 640,
            height: 360,
          });
          await db.update(schema.jobs).set({ leaseToken: 'winner-thumbnail-token' })
            .where(eq(schema.jobs.id, takeoverJob.id));
          return `storage://${storageKey}`;
        },
        deleteStorageObject: async (storageKey) => {
          takeoverCompensationCalls += 1;
          takeoverObjects.delete(storageKey);
        },
      }
    ).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error })
    );
    assert.match(String((await takeoverWork).error), /not authorized/i);
    assert.equal(takeoverCompensationCalls, 0);
    assert.equal(takeoverObjects.size, 1);
    assert.ok(await db.query.sourceAssetThumbnailVariants.findFirst({
      where: (row, { eq }) => eq(row.sourceAssetId, thumbnailTakeover.sourceAsset.id),
    }));

    const compensationFailure = await createSource('thumbnail-compensation-failure');
    const [compensationFailureJob] = await db.insert(schema.jobs).values({
      type: schema.JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL,
      status: schema.JobStatus.PROCESSING,
      idempotencyKey: `phase2:thumbnail-compensation-failure:${randomUUID()}`,
      payload: { sourceAssetId: compensationFailure.sourceAsset.id, userId: user.id },
      leaseToken: 'compensation-failure-token',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    }).returning();
    const compensationUploadStarted = deferred();
    const releaseCompensationUpload = deferred();
    const compensationObjects = new Set<string>();
    const compensationLogs: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => { compensationLogs.push(args); };
    try {
      const compensationWork = extractSourceAssetThumbnail(
        compensationFailure.sourceAsset.id,
        user.id,
        { jobId: compensationFailureJob.id, leaseToken: 'compensation-failure-token' },
        {
          createDownload: () => ({ method: 'GET', downloadUrl: 'https://mock.invalid/source' }),
          extractFrame: async () => undefined,
          readImageDimensions: async () => ({ width: 640, height: 360 }),
          readFile: (async () => Buffer.from('thumbnail')) as never,
          uploadStorageObject: async ({ storageKey }) => {
            compensationUploadStarted.resolve();
            await releaseCompensationUpload.promise;
            compensationObjects.add(storageKey);
            return `storage://${storageKey}`;
          },
          deleteStorageObject: async () => {
            throw new Error('mock compensation unavailable');
          },
        }
      ).then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error })
      );
      await compensationUploadStarted.promise;
      await db.update(schema.jobs).set({ leaseExpiresAt: new Date(0) })
        .where(eq(schema.jobs.id, compensationFailureJob.id));
      assert.equal((await deleteProjectGraph({
        projectId: compensationFailure.project.id,
        userId: user.id,
        deleteStorageObject: async (storageKey) => { compensationObjects.delete(storageKey); },
      })).deleted, true);
      releaseCompensationUpload.resolve();
      assert.match(String((await compensationWork).error), /not authorized/i);
      assert.equal(compensationObjects.size, 1);
      assert.ok(compensationLogs.some(([event]) =>
        event === 'source_thumbnail.compensation_failed'
      ));
    } finally {
      console.error = originalConsoleError;
    }

    const originalFetch = globalThis.fetch;
    const originalStorageEnv = {
      accessKeyId: process.env.S3_UPLOAD_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_UPLOAD_SECRET_ACCESS_KEY,
      bucket: process.env.S3_UPLOAD_BUCKET,
      region: process.env.S3_UPLOAD_REGION,
      endpoint: process.env.S3_UPLOAD_ENDPOINT,
      pathStyle: process.env.S3_UPLOAD_PATH_STYLE,
    };
    const storageSignalController = new AbortController();
    let fetchSignal: AbortSignal | null | undefined;
    try {
      process.env.S3_UPLOAD_ACCESS_KEY_ID = 'test-access-key';
      process.env.S3_UPLOAD_SECRET_ACCESS_KEY = 'test-secret-key';
      process.env.S3_UPLOAD_BUCKET = 'test-bucket';
      process.env.S3_UPLOAD_REGION = 'us-east-1';
      process.env.S3_UPLOAD_ENDPOINT = 'https://storage.invalid';
      process.env.S3_UPLOAD_PATH_STYLE = 'true';
      globalThis.fetch = async (_input, init) => {
        fetchSignal = init?.signal;
        return new Response('', { status: 200 });
      };
      await uploadStorageObject({
        storageKey: 'uploads/signal-test.jpg',
        mimeType: 'image/jpeg',
        body: Buffer.from('thumbnail'),
        signal: storageSignalController.signal,
      });
      assert.equal(fetchSignal, storageSignalController.signal);
    } finally {
      globalThis.fetch = originalFetch;
      for (const [name, value] of Object.entries({
        S3_UPLOAD_ACCESS_KEY_ID: originalStorageEnv.accessKeyId,
        S3_UPLOAD_SECRET_ACCESS_KEY: originalStorageEnv.secretAccessKey,
        S3_UPLOAD_BUCKET: originalStorageEnv.bucket,
        S3_UPLOAD_REGION: originalStorageEnv.region,
        S3_UPLOAD_ENDPOINT: originalStorageEnv.endpoint,
        S3_UPLOAD_PATH_STYLE: originalStorageEnv.pathStyle,
      })) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  } finally {
    await appClient?.end();
    await blocker?.end();
    await observer?.end();
    await admin.unsafe(`drop schema if exists "${schemaName}" cascade`);
    await admin.end();
  }
});
