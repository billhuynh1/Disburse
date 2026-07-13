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
    process.env.POSTGRES_URL = isolatedUrl.toString();

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
      JobEnqueueBlockedError,
    } = await import('./job-service.ts');

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
      { type: schema.JobType.DETECT_CLIP_FACECAM, payload: { sourceAssetId: lifecycle.sourceAsset.id, contentPackId: contentPack.id, clipCandidateId: candidate.id, userId: user.id, generationRunId } },
      { type: schema.JobType.PUBLISH_RENDERED_CLIP, payload: { clipPublicationId: publication.id, renderedClipId: renderedClip.id, linkedAccountId: linkedAccount.id, userId: user.id, platform: 'youtube' } },
    ];
    await db.insert(schema.jobs).values(jobPayloads.map(({ type, payload }, index) => ({
      type,
      status: schema.JobStatus.PENDING,
      idempotencyKey: `phase2:all-types:${index}:${randomUUID()}`,
      payload,
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
    assert.equal(retryStorageKeys.length, 4);
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
    const repeatedResults = await Promise.all([
      deleteProjectGraph({
        projectId: repeatedConcurrent.project.id,
        userId: user.id,
        deleteStorageObject: async () => undefined,
      }),
      deleteProjectGraph({
        projectId: repeatedConcurrent.project.id,
        userId: user.id,
        deleteStorageObject: async () => undefined,
      }),
    ]);
    assert.ok(repeatedResults.some((result) => result.deleted));
    assert.equal(await db.query.projects.findFirst({
      where: (row, { eq }) => eq(row.id, repeatedConcurrent.project.id),
    }), undefined);

    const racing = await createSource('racing');
    const deletion = deleteProjectGraph({
      projectId: racing.project.id,
      userId: user.id,
      deleteStorageObject: async () => undefined,
    });
    const enqueue = enqueueTranscriptionJob(racing.sourceAsset.id, user.id);
    const [deletionOutcome, enqueueOutcome] = await Promise.allSettled([deletion, enqueue]);
    assert.equal(deletionOutcome.status, 'fulfilled');
    if (enqueueOutcome.status === 'fulfilled') {
      const queuedJob = enqueueOutcome.value;
      assert.ok(queuedJob);
      const persisted = await db.query.jobs.findFirst({
        where: (row, { eq }) => eq(row.id, queuedJob.id),
      });
      assert.equal(persisted!.status, schema.JobStatus.CANCELLED);
    } else {
      assert.ok(enqueueOutcome.reason instanceof JobEnqueueBlockedError);
    }
  } finally {
    await appClient?.end();
    await admin.unsafe(`drop schema if exists "${schemaName}" cascade`);
    await admin.end();
  }
});
