import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { register } from 'node:module';
import test from 'node:test';
import { and, eq, sql, type SQLWrapper } from 'drizzle-orm';
import postgres from 'postgres';

register('../test/typescript-path-loader.mjs', import.meta.url);

test('production reconciliation is bounded, race-safe, replayable, and idempotent', {
  skip: !process.env.PHASE1A_TEST_DATABASE_URL,
}, async () => {
  const configuredUrl = process.env.PHASE1A_TEST_DATABASE_URL!;
  const parsed = new URL(configuredUrl);
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(parsed.hostname));
  assert.equal(parsed.pathname.replace(/^\//, ''), 'disburse_phase1a_test');

  const schemaName = `reconciliation_${randomUUID().replaceAll('-', '')}`;
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
    const { buildJobIdempotencyKey } = await import('./job-identity.ts');
    const {
      reconcilePipelinePage,
      reconcileProjectPipeline,
    } = await import('./pipeline-reconciliation-service.ts');

    const [user] = await db.insert(schema.users).values({
      email: `reconcile-${randomUUID()}@example.com`,
      passwordHash: 'test',
    }).returning();
    const createProject = async (name: string) => (
      await db.insert(schema.projects).values({ userId: user.id, name, isSaved: true }).returning()
    )[0]!;
    const createSource = async (
      projectId: number,
      name: string,
      assetType = schema.SourceAssetType.UPLOADED_FILE
    ) => (
      await db.insert(schema.sourceAssets).values({
        userId: user.id,
        projectId,
        title: name,
        assetType,
        mimeType: assetType === schema.SourceAssetType.UPLOADED_FILE ? 'video/mp4' : null,
        storageKey: assetType === schema.SourceAssetType.UPLOADED_FILE ? `${name}.mp4` : null,
        storageUrl: `storage://${name}`,
        status: schema.SourceAssetStatus.UPLOADED,
      }).returning()
    )[0]!;
    const createReadyTranscript = async (sourceAssetId: number) => (
      await db.insert(schema.transcripts).values({
        userId: user.id,
        sourceAssetId,
        content: 'A durable grounded transcript.',
        status: schema.TranscriptStatus.READY,
      }).returning()
    )[0]!;
    const createPack = async (
      projectId: number,
      sourceAssetId: number,
      transcriptId: number,
      generationRunId: string,
      status = schema.ContentPackStatus.GENERATING
    ) => (
      await db.insert(schema.contentPacks).values({
        userId: user.id,
        projectId,
        sourceAssetId,
        transcriptId,
        kind: schema.ContentPackKind.SHORT_FORM_CLIPS,
        name: `pack-${generationRunId}`,
        generationRunId,
        status,
      }).returning()
    )[0]!;
    const createCandidate = async (
      pack: typeof schema.contentPacks.$inferSelect,
      transcriptId: number
    ) => (
      await db.insert(schema.clipCandidates).values({
        userId: user.id,
        contentPackId: pack.id,
        sourceAssetId: pack.sourceAssetId,
        transcriptId,
        rank: 1,
        startTimeMs: 0,
        endTimeMs: 20_000,
        durationMs: 20_000,
        hook: 'Hook',
        title: 'Title',
        captionCopy: 'Caption',
        summary: 'Summary',
        transcriptExcerpt: 'Excerpt',
        whyItWorks: 'Grounded',
        platformFit: 'short-form',
        confidence: 90,
        generationRunId: pack.generationRunId,
      }).returning()
    )[0]!;
    const insertGenerationJob = async (
      pack: typeof schema.contentPacks.$inferSelect,
      status = schema.JobStatus.COMPLETED
    ) => {
      const payload = {
        contentPackId: pack.id,
        sourceAssetId: pack.sourceAssetId,
        transcriptId: pack.transcriptId ?? undefined,
        userId: user.id,
        generationRunId: pack.generationRunId,
      };
      return (
        await db.insert(schema.jobs).values({
          type: schema.JobType.GENERATE_SHORT_FORM_PACK,
          status,
          idempotencyKey: buildJobIdempotencyKey(
            schema.JobType.GENERATE_SHORT_FORM_PACK,
            payload
          ),
          payload,
          completedAt: status === schema.JobStatus.COMPLETED ? new Date() : null,
        }).returning()
      )[0]!;
    };

    const missingProject = await createProject('missing-transcription');
    const missingSource = await createSource(missingProject.id, 'missing-transcription');
    await Promise.all([
      reconcileProjectPipeline(missingProject.id),
      reconcileProjectPipeline(missingProject.id),
    ]);
    const transcriptionIdentity = `transcribe_source_asset:source:${missingSource.id}:v1`;
    assert.equal((await db.select().from(schema.jobs)
      .where(eq(schema.jobs.idempotencyKey, transcriptionIdentity))).length, 1);

    const completedMissingProject = await createProject('completed-missing-transcript');
    const completedMissingSource = await createSource(
      completedMissingProject.id,
      'completed-missing-transcript'
    );
    await db.insert(schema.jobs).values({
      type: schema.JobType.TRANSCRIBE_SOURCE_ASSET,
      status: schema.JobStatus.COMPLETED,
      idempotencyKey: `transcribe_source_asset:source:${completedMissingSource.id}:v1`,
      payload: { sourceAssetId: completedMissingSource.id, userId: user.id },
      completedAt: new Date(),
    });
    await reconcileProjectPipeline(completedMissingProject.id);
    const terminalSource = await db.query.sourceAssets.findFirst({
      where: eq(schema.sourceAssets.id, completedMissingSource.id),
    });
    assert.equal(terminalSource!.status, schema.SourceAssetStatus.FAILED);
    assert.match(terminalSource!.failureReason!, /transcript_completed_result_missing/);

    const generationProject = await createProject('generation');
    const generationSource = await createSource(
      generationProject.id,
      'generation',
      schema.SourceAssetType.YOUTUBE_URL
    );
    const generationTranscript = await createReadyTranscript(generationSource.id);
    const preservedRun = randomUUID();
    const generationPack = await createPack(
      generationProject.id,
      generationSource.id,
      generationTranscript.id,
      preservedRun,
      schema.ContentPackStatus.PENDING
    );
    await Promise.all([
      reconcileProjectPipeline(generationProject.id),
      reconcileProjectPipeline(generationProject.id),
    ]);
    const repairedPack = await db.query.contentPacks.findFirst({
      where: eq(schema.contentPacks.id, generationPack.id),
    });
    assert.equal(repairedPack!.generationRunId, preservedRun);
    const generationJobs = await db.select().from(schema.jobs).where(and(
      eq(schema.jobs.type, schema.JobType.GENERATE_SHORT_FORM_PACK),
      eq(schema.jobs.idempotencyKey, `generate-short-form:pack:${generationPack.id}:run:${preservedRun}`)
    ));
    assert.equal(generationJobs.length, 1);
    const transcriptNotifications = await db.select().from(schema.notifications).where(and(
      eq(schema.notifications.entityType, 'transcript'),
      eq(schema.notifications.entityId, generationTranscript.id)
    ));
    assert.equal(transcriptNotifications.length, 1);
    await db.delete(schema.notifications).where(
      eq(schema.notifications.id, transcriptNotifications[0]!.id)
    );
    await reconcileProjectPipeline(generationProject.id);
    assert.equal((await db.select().from(schema.notifications).where(and(
      eq(schema.notifications.entityType, 'transcript'),
      eq(schema.notifications.entityId, generationTranscript.id)
    ))).length, 1);

    const renderProject = await createProject('render-replay');
    const renderSource = await createSource(
      renderProject.id,
      'render-replay',
      schema.SourceAssetType.YOUTUBE_URL
    );
    const renderTranscript = await createReadyTranscript(renderSource.id);
    const renderPack = await createPack(
      renderProject.id,
      renderSource.id,
      renderTranscript.id,
      randomUUID()
    );
    await insertGenerationJob(renderPack);
    const renderCandidate = await createCandidate(renderPack, renderTranscript.id);
    await Promise.all([
      reconcileProjectPipeline(renderProject.id),
      reconcileProjectPipeline(renderProject.id),
    ]);
    const formatJobs = await db.select().from(schema.jobs).where(and(
      eq(schema.jobs.type, schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM),
      eq(sqlNumber(schema.jobs.payload, 'clipCandidateId'), renderCandidate.id)
    ));
    assert.equal(formatJobs.length, 1);
    await db.update(schema.jobs).set({
      status: schema.JobStatus.COMPLETED,
      completedAt: new Date(),
    }).where(eq(schema.jobs.id, formatJobs[0]!.id));
    await reconcileProjectPipeline(renderProject.id);
    await reconcileProjectPipeline(renderProject.id);
    const failedArtifacts = await db.select().from(schema.renderedClips).where(
      eq(schema.renderedClips.clipCandidateId, renderCandidate.id)
    );
    assert.equal(failedArtifacts.length, 1);
    assert.equal(failedArtifacts[0]!.status, schema.RenderedClipStatus.FAILED);

    const facecamProject = await createProject('facecam-terminal');
    const facecamSource = await createSource(facecamProject.id, 'facecam-terminal');
    const facecamTranscript = await createReadyTranscript(facecamSource.id);
    const facecamPack = await createPack(
      facecamProject.id,
      facecamSource.id,
      facecamTranscript.id,
      randomUUID()
    );
    await insertGenerationJob(facecamPack);
    const facecamCandidate = await createCandidate(facecamPack, facecamTranscript.id);
    await Promise.all([
      reconcileProjectPipeline(facecamProject.id),
      reconcileProjectPipeline(facecamProject.id),
    ]);
    const facecamJobs = await db.select().from(schema.jobs).where(and(
      eq(schema.jobs.type, schema.JobType.DETECT_CLIP_FACECAM),
      eq(sqlNumber(schema.jobs.payload, 'clipCandidateId'), facecamCandidate.id)
    ));
    assert.equal(facecamJobs.length, 1);
    const detectionRun = await db.query.clipCandidateFacecamDetectionRuns.findFirst({
      where: eq(
        schema.clipCandidateFacecamDetectionRuns.clipCandidateId,
        facecamCandidate.id
      ),
    });
    assert.ok(detectionRun);
    await db.update(schema.clipCandidateFacecamDetectionRuns).set({
      status: schema.FacecamDetectionStatus.NOT_FOUND,
      completedAt: new Date(),
    }).where(eq(schema.clipCandidateFacecamDetectionRuns.id, detectionRun.id));
    await db.update(schema.jobs).set({
      status: schema.JobStatus.COMPLETED,
      completedAt: new Date(),
    }).where(eq(schema.jobs.id, facecamJobs[0]!.id));
    await Promise.all([
      reconcileProjectPipeline(facecamProject.id),
      reconcileProjectPipeline(facecamProject.id),
    ]);
    const projectedCandidate = await db.query.clipCandidates.findFirst({
      where: eq(schema.clipCandidates.id, facecamCandidate.id),
    });
    assert.equal(
      projectedCandidate!.facecamDetectionStatus,
      schema.FacecamDetectionStatus.NOT_FOUND
    );
    const facecamRenderJobs = await db.select().from(schema.jobs).where(and(
      eq(schema.jobs.type, schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM),
      eq(sqlNumber(schema.jobs.payload, 'clipCandidateId'), facecamCandidate.id)
    ));
    assert.equal(facecamRenderJobs.length, 1);

    const rebuildProject = await createProject('bounded-rebuild');
    const rebuildSource = await createSource(
      rebuildProject.id,
      'bounded-rebuild',
      schema.SourceAssetType.YOUTUBE_URL
    );
    const rebuildTranscript = await createReadyTranscript(rebuildSource.id);
    const rebuildPack = await createPack(
      rebuildProject.id,
      rebuildSource.id,
      rebuildTranscript.id,
      randomUUID()
    );
    await insertGenerationJob(rebuildPack);
    await db.insert(schema.jobs).values({
      type: schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
      status: schema.JobStatus.CANCELLED,
      idempotencyKey: `missing-candidate:${randomUUID()}`,
      payload: {
        sourceAssetId: rebuildSource.id,
        contentPackId: rebuildPack.id,
        clipCandidateId: 999_999,
        userId: user.id,
        generationRunId: rebuildPack.generationRunId,
      },
      cancellationReason: 'clip_candidate_missing',
      cancellationRequestedAt: new Date(),
      completedAt: new Date(),
    });
    await Promise.all([
      reconcileProjectPipeline(rebuildProject.id),
      reconcileProjectPipeline(rebuildProject.id),
    ]);
    const rebuilt = await db.query.contentPacks.findFirst({
      where: eq(schema.contentPacks.id, rebuildPack.id),
    });
    assert.notEqual(rebuilt!.generationRunId, rebuildPack.generationRunId);
    const rebuildJobs = await db.select().from(schema.jobs).where(
      eq(schema.jobs.type, schema.JobType.GENERATE_SHORT_FORM_PACK)
    );
    assert.equal(
      rebuildJobs.filter((job) =>
        'contentPackId' in job.payload && job.payload.contentPackId === rebuildPack.id
      ).length,
      2
    );

    const deletingProject = await createProject('deleting');
    const deletingSource = await createSource(deletingProject.id, 'deleting');
    await db.update(schema.projects).set({ deletionRequestedAt: new Date() })
      .where(eq(schema.projects.id, deletingProject.id));
    const refusal = await reconcileProjectPipeline(deletingProject.id);
    assert.deepEqual(refusal.map((item) => item.reason), ['project_deleting']);
    assert.equal((await db.select().from(schema.jobs).where(
      eq(sqlNumber(schema.jobs.payload, 'sourceAssetId'), deletingSource.id)
    )).length, 0);

    const paging = await reconcilePipelinePage({
      afterProjectId: completedMissingProject.id,
      pageSize: 1,
    });
    assert.deepEqual(paging.projectIds, [generationProject.id]);
    assert.equal(paging.nextAfterProjectId, generationProject.id);
    assert.equal((await reconcilePipelinePage({ pageSize: 500 })).projectIds.length <= 50, true);

    const beforeCounts = await admin.unsafe(`
      select
        (select count(*)::int from "${schemaName}".jobs) as jobs,
        (select count(*)::int from "${schemaName}".notifications) as notifications
    `);
    await reconcileProjectPipeline(renderProject.id);
    const afterCounts = await admin.unsafe(`
      select
        (select count(*)::int from "${schemaName}".jobs) as jobs,
        (select count(*)::int from "${schemaName}".notifications) as notifications
    `);
    assert.deepEqual(afterCounts[0], beforeCounts[0]);
  } finally {
    await appClient?.end();
    await admin.unsafe(`drop schema if exists "${schemaName}" cascade`);
    await admin.end();
  }
});

function sqlNumber(column: SQLWrapper, key: string) {
  return sql<number>`cast(${column}->>${key} as integer)`;
}
