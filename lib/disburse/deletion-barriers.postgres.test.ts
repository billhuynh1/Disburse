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
      acknowledgeJobCancellation,
    } = await import('./job-service.ts');
    const { ensureShortFormContentPack } = await import('./short-form-service.ts');
    const { extractSourceAssetThumbnail } = await import('./source-asset-thumbnail-service.ts');
    const { claimSourceUploadSessionForCompletion } = await import('./source-asset-upload-service.ts');
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
    let clearedProject = false;
    const clearedProjectResult = await deleteProjectGraph({
      projectId: clearedProjectIntent.project.id,
      userId: user.id,
      deleteStorageObject: async () => {
        if (clearedProject) return;
        clearedProject = true;
        await db.update(schema.projects).set({ deletionRequestedAt: null })
          .where(eq(schema.projects.id, clearedProjectIntent.project.id));
      },
    });
    assert.equal(clearedProjectResult.deleted, false);
    assert.ok(await db.query.projects.findFirst({
      where: (row, { eq }) => eq(row.id, clearedProjectIntent.project.id),
    }));

    const clearedSourceIntent = await createSource('cleared-source-intent');
    let clearedSource = false;
    const clearedSourceResult = await deleteSourceAssetGraph({
      projectId: clearedSourceIntent.project.id,
      sourceAssetId: clearedSourceIntent.sourceAsset.id,
      userId: user.id,
      deleteStorageObject: async () => {
        if (clearedSource) return;
        clearedSource = true;
        await db.update(schema.sourceAssets).set({ deletionRequestedAt: null })
          .where(eq(schema.sourceAssets.id, clearedSourceIntent.sourceAsset.id));
      },
    });
    assert.equal(clearedSourceResult.deleted, false);
    assert.ok(await db.query.sourceAssets.findFirst({
      where: (row, { eq }) => eq(row.id, clearedSourceIntent.sourceAsset.id),
    }));

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
    const thumbnailWork = extractSourceAssetThumbnail(
      thumbnailRace.sourceAsset.id,
      user.id,
      { jobId: thumbnailJob.id, leaseToken: 'thumbnail-token' },
      {
        createDownload: () => ({ method: 'GET', downloadUrl: 'https://mock.invalid/source' }),
        extractFrame: async () => undefined,
        readImageDimensions: async () => ({ width: 640, height: 360 }),
        readFile: (async () => Buffer.from('thumbnail')) as never,
        uploadStorageObject: async ({ storageKey }) => {
          uploadedThumbnailKey = storageKey;
          uploadStarted.resolve();
          await releaseUpload.promise;
          return `storage://${storageKey}`;
        },
      }
    ).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error })
    );
    await uploadStarted.promise;
    let thumbnailCleanupCalls = 0;
    assert.equal((await deleteProjectGraph({
      projectId: thumbnailRace.project.id,
      userId: user.id,
      deleteStorageObject: async () => { thumbnailCleanupCalls += 1; },
    })).pending, true);
    assert.equal(thumbnailCleanupCalls, 0);
    releaseUpload.resolve();
    assert.match(String((await thumbnailWork).error), /not authorized/i);
    assert.equal(await acknowledgeJobCancellation(thumbnailJob.id, 'thumbnail-token'), true);
    const cleanedThumbnailKeys = new Set<string>();
    assert.equal((await deleteProjectGraph({
      projectId: thumbnailRace.project.id,
      userId: user.id,
      deleteStorageObject: async (storageKey) => { cleanedThumbnailKeys.add(storageKey); },
    })).deleted, true);
    assert.ok(cleanedThumbnailKeys.has(uploadedThumbnailKey));
  } finally {
    await appClient?.end();
    await blocker?.end();
    await observer?.end();
    await admin.unsafe(`drop schema if exists "${schemaName}" cascade`);
    await admin.end();
  }
});
