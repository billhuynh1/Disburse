import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { register } from 'node:module';
import test from 'node:test';
import { and, eq, inArray, sql, type SQLWrapper } from 'drizzle-orm';
import postgres from 'postgres';

register('../test/typescript-path-loader.mjs', import.meta.url);

test('production reconciliation is bounded, race-safe, replayable, and idempotent', {
  skip: !process.env.PHASE1A_TEST_DATABASE_URL,
}, async (t) => {
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
    const reconciliationApplicationName = `phase3_${schemaName}`;
    isolatedUrl.searchParams.set('application_name', reconciliationApplicationName);
    process.env.POSTGRES_URL = isolatedUrl.toString();
    const { client, db } = await import('../db/drizzle.ts');
    appClient = client;
    const schema = await import('../db/schema.ts');
    const { buildJobIdempotencyKey } = await import('./job-identity.ts');
    const { createFacecamDetectionNotification } = await import('./notification-service.ts');
    const { deleteProjectGraph, deleteSourceAssetGraph } = await import('./media-retention-service.ts');
    const {
      enqueueFormatRenderedClipShortFormJob,
      withAuthorizedJobCompletion,
    } = await import('./job-service.ts');
    const {
      processClaimedJob,
      productionPipelineProcessingRuntime,
    } = await import('./pipeline-service.ts');
    const {
      reconcilePipelinePage,
      reconcileProjectPipeline,
    } = await import('./pipeline-reconciliation-service.ts');
    const raceReconciliation = async (
      projectId: number,
      whileLocked?: () => Promise<void>
    ) => {
      const blocker = postgres(isolatedUrl.toString(), { max: 1 });
      let signalLocked!: () => void;
      let releaseLock!: () => void;
      const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
      const release = new Promise<void>((resolve) => { releaseLock = resolve; });
      const holding = blocker.begin(async (connection) => {
        await connection.unsafe(
          `select id from "${schemaName}".projects where id = $1 for update`,
          [projectId]
        );
        signalLocked();
        await release;
      });
      await locked;
      const first = reconcileProjectPipeline(projectId);
      const second = reconcileProjectPipeline(projectId);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const waiting = await admin.unsafe(`
          select pid from pg_stat_activity
          where application_name = $1
            and wait_event_type = 'Lock'
            and query like '%projects%for update%'
        `, [reconciliationApplicationName]);
        if (waiting.length >= 1) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const waiting = await admin.unsafe(`
        select pid from pg_stat_activity
        where application_name = $1
          and wait_event_type = 'Lock'
          and query like '%projects%for update%'
      `, [reconciliationApplicationName]);
      assert.ok(waiting.length >= 1, 'the named reconciler must wait on the project row lock');
      await whileLocked?.();
      releaseLock();
      await holding;
      await first;
      await second;
      await blocker.end();
    };
    const raceDeletionWithReconciliation = async <T>(
      projectId: number,
      deletion: () => Promise<T>
    ) => {
      const blocker = postgres(isolatedUrl.toString(), { max: 1 });
      let signalLocked!: () => void;
      let releaseLock!: () => void;
      const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
      const release = new Promise<void>((resolve) => { releaseLock = resolve; });
      const holding = blocker.begin(async (connection) => {
        await connection.unsafe(
          `select id from "${schemaName}".projects where id = $1 for update`,
          [projectId]
        );
        signalLocked();
        await release;
      });
      await locked;
      const deletionResult = deletion();
      let deletionPid: number | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const waiting = await admin.unsafe(`
          select pid from pg_stat_activity
          where application_name = $1 and wait_event_type = 'Lock'
        `, [reconciliationApplicationName]);
        if (waiting.length === 1) {
          deletionPid = waiting[0]!.pid;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.ok(deletionPid, 'the deletion session must reach the explicit project barrier');
      const reconciliation = reconcileProjectPipeline(projectId);
      let reconciliationPid: number | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const waiting = await admin.unsafe(`
          select pid from pg_stat_activity
          where application_name = $1
            and wait_event_type = 'Lock'
            and pid <> $2
        `, [reconciliationApplicationName, deletionPid!]);
        if (waiting.length >= 1) {
          reconciliationPid = waiting[0]!.pid;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.ok(reconciliationPid, 'the reconciliation session must reach the same barrier');
      releaseLock();
      await holding;
      const deleted = await deletionResult;
      await reconciliation;
      await blocker.end();
      return deleted;
    };

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
      transcriptId: number,
      rank = 1
    ) => (
      await db.insert(schema.clipCandidates).values({
        userId: user.id,
        contentPackId: pack.id,
        sourceAssetId: pack.sourceAssetId,
        transcriptId,
        rank,
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
    const createFinalizedPack = async (
      name: string,
      outcomes: Array<typeof schema.RenderedClipStatus.READY | typeof schema.RenderedClipStatus.FAILED>
    ) => {
      const project = await createProject(name);
      const source = await createSource(project.id, name, schema.SourceAssetType.YOUTUBE_URL);
      const transcript = await createReadyTranscript(source.id);
      const pack = await createPack(project.id, source.id, transcript.id, randomUUID());
      await insertGenerationJob(pack);
      const candidates = [];
      for (let index = 0; index < outcomes.length; index += 1) {
        const candidate = await createCandidate(pack, transcript.id, index + 1);
        candidates.push(candidate);
      }
      await raceReconciliation(project.id);
      const configs = await db.select().from(schema.clipEditConfigs).where(
        inArray(schema.clipEditConfigs.clipCandidateId, candidates.map((candidate) => candidate.id))
      );
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index]!;
        const config = configs.find((item) => item.clipCandidateId === candidate.id)!;
        await db.insert(schema.renderedClips).values({
          userId: user.id,
          contentPackId: pack.id,
          sourceAssetId: source.id,
          clipCandidateId: candidate.id,
          generationRunId: pack.generationRunId,
          variant: schema.RenderedClipVariant.VERTICAL_SHORT_FORM,
          layout: config.layout,
          editConfigId: config.id,
          editConfigVersion: config.configVersion,
          editConfigHash: config.configHash,
          status: outcomes[index]!,
          title: candidate.title,
          startTimeMs: candidate.startTimeMs,
          endTimeMs: candidate.endTimeMs,
          durationMs: candidate.durationMs,
          failureReason: outcomes[index] === schema.RenderedClipStatus.FAILED
            ? 'deterministic-render-failure'
            : null,
          storageKey: outcomes[index] === schema.RenderedClipStatus.READY
            ? `${name}-${candidate.id}.mp4`
            : null,
        });
      }
      await reconcileProjectPipeline(project.id);
      return {
        project,
        pack: await db.query.contentPacks.findFirst({
          where: eq(schema.contentPacks.id, pack.id),
        }),
      };
    };
    const snapshotReconciliationRows = async () => {
      const [row] = await admin.unsafe(`
        select jsonb_build_object(
          'projects', (select coalesce(jsonb_agg(to_jsonb(t) order by id), '[]') from "${schemaName}".projects t),
          'sources', (select coalesce(jsonb_agg(to_jsonb(t) order by id), '[]') from "${schemaName}".source_assets t),
          'transcripts', (select coalesce(jsonb_agg(to_jsonb(t) order by id), '[]') from "${schemaName}".transcripts t),
          'packs', (select coalesce(jsonb_agg(to_jsonb(t) order by id), '[]') from "${schemaName}".content_packs t),
          'candidates', (select coalesce(jsonb_agg(to_jsonb(t) order by id), '[]') from "${schemaName}".clip_candidates t),
          'editConfigs', (select coalesce(jsonb_agg(to_jsonb(t) order by id), '[]') from "${schemaName}".clip_edit_configs t),
          'renderConfigs', (select coalesce(jsonb_agg(to_jsonb(t) order by id), '[]') from "${schemaName}".clip_render_configs t),
          'runs', (select coalesce(jsonb_agg(to_jsonb(t) order by id), '[]') from "${schemaName}".clip_candidate_facecam_detection_runs t),
          'clips', (select coalesce(jsonb_agg(to_jsonb(t) order by id), '[]') from "${schemaName}".rendered_clips t),
          'jobs', (select coalesce(jsonb_agg(to_jsonb(t) order by id), '[]') from "${schemaName}".jobs t),
          'notifications', (select coalesce(jsonb_agg(to_jsonb(t) order by id), '[]') from "${schemaName}".notifications t)
        ) as snapshot
      `);
      return row!.snapshot;
    };

    const missingProject = await createProject('missing-transcription');
    const missingSource = await createSource(missingProject.id, 'missing-transcription');
    await raceReconciliation(missingProject.id);
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

    const emptyTranscriptProject = await createProject('empty-ready-transcript');
    const emptyTranscriptSource = await createSource(
      emptyTranscriptProject.id,
      'empty-ready-transcript',
      schema.SourceAssetType.PASTED_TRANSCRIPT
    );
    await db.insert(schema.transcripts).values({
      userId: user.id,
      sourceAssetId: emptyTranscriptSource.id,
      content: '   ',
      status: schema.TranscriptStatus.READY,
    });
    await reconcileProjectPipeline(emptyTranscriptProject.id);
    const emptyTranscriptTerminal = await db.query.sourceAssets.findFirst({
      where: eq(schema.sourceAssets.id, emptyTranscriptSource.id),
    });
    assert.equal(emptyTranscriptTerminal!.status, schema.SourceAssetStatus.FAILED);
    assert.match(emptyTranscriptTerminal!.failureReason!, /transcript_ready_content_missing/);
    assert.equal((await db.select().from(schema.jobs).where(
      eq(sqlText(schema.jobs.payload, 'sourceAssetId'), String(emptyTranscriptSource.id))
    )).length, 0, 'reconciliation must not repeat external transcription');

    const malformedProject = await createProject('malformed-history');
    const malformedSource = await createSource(malformedProject.id, 'malformed-history');
    const malformedPayloads = [
      { sourceAssetId: malformedSource.id, userId: 'bad' },
      { sourceAssetId: malformedSource.id, userId: user.id, contentPackId: 'bad', generationRunId: 'run' },
      { sourceAssetId: malformedSource.id, userId: user.id, contentPackId: 1, clipCandidateId: 'bad', generationRunId: 'run' },
      { sourceAssetId: malformedSource.id, userId: user.id, contentPackId: 1, clipCandidateId: 1, generationRunId: 12 },
    ];
    for (const [index, payload] of malformedPayloads.entries()) {
      await db.insert(schema.jobs).values({
        type: index === 0
          ? schema.JobType.TRANSCRIBE_SOURCE_ASSET
          : schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
        status: schema.JobStatus.CANCELLED,
        idempotencyKey: `malformed:${randomUUID()}`,
        payload: payload as never,
        cancellationReason: 'clip_candidate_missing',
      });
    }
    const malformedEvents = await reconcileProjectPipeline(malformedProject.id);
    assert.equal(
      malformedEvents.filter((item) => item.reason === 'job_payload_malformed').length,
      malformedPayloads.length
    );

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
    await raceReconciliation(generationProject.id);
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
    await raceReconciliation(renderProject.id);
    const formatJobs = await db.select().from(schema.jobs).where(and(
      eq(schema.jobs.type, schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM),
      eq(sqlText(schema.jobs.payload, 'clipCandidateId'), String(renderCandidate.id)),
      eq(sqlText(schema.jobs.payload, 'contentPackId'), String(renderPack.id))
    ));
    assert.equal(formatJobs.length, 1, JSON.stringify(formatJobs.map((job) => job.payload)));
    const legacyPayload = { ...formatJobs[0]!.payload } as Record<string, unknown>;
    delete legacyPayload.editConfigId;
    delete legacyPayload.renderConfigId;
    await db.update(schema.jobs).set({
      payload: legacyPayload as never,
      idempotencyKey: `legacy-format:${randomUUID()}`,
    }).where(eq(schema.jobs.id, formatJobs[0]!.id));
    const rolloutConfig = await db.query.clipEditConfigs.findFirst({
      where: eq(schema.clipEditConfigs.clipCandidateId, renderCandidate.id),
    });
    assert.ok(rolloutConfig);
    const pendingReuse = await enqueueFormatRenderedClipShortFormJob(
      renderCandidate.id,
      renderPack.id,
      renderSource.id,
      user.id,
      renderPack.generationRunId,
      schema.RenderedClipVariant.VERTICAL_SHORT_FORM,
      rolloutConfig.layout as typeof schema.RenderedClipLayout.DEFAULT,
      rolloutConfig.captionsEnabled,
      rolloutConfig.captionFontAssetId ?? undefined,
      rolloutConfig.configHash,
      undefined,
      true,
      'rollout-compatibility-test',
      db
    );
    assert.equal(pendingReuse!.id, formatJobs[0]!.id);
    await reconcileProjectPipeline(renderProject.id);
    assert.equal((await db.select().from(schema.jobs).where(and(
      eq(schema.jobs.type, schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM),
      eq(sqlText(schema.jobs.payload, 'contentPackId'), String(renderPack.id))
    ))).length, 1, 'legacy pending work blocks exact rollout enqueue');
    await db.update(schema.jobs).set({ status: schema.JobStatus.PROCESSING })
      .where(eq(schema.jobs.id, formatJobs[0]!.id));
    const processingReuse = await enqueueFormatRenderedClipShortFormJob(
      renderCandidate.id,
      renderPack.id,
      renderSource.id,
      user.id,
      renderPack.generationRunId,
      schema.RenderedClipVariant.VERTICAL_SHORT_FORM,
      rolloutConfig.layout as typeof schema.RenderedClipLayout.DEFAULT,
      rolloutConfig.captionsEnabled,
      rolloutConfig.captionFontAssetId ?? undefined,
      rolloutConfig.configHash,
      undefined,
      true,
      'rollout-compatibility-test',
      db
    );
    assert.equal(processingReuse!.id, formatJobs[0]!.id);
    await reconcileProjectPipeline(renderProject.id);
    assert.equal((await db.select().from(schema.jobs).where(and(
      eq(schema.jobs.type, schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM),
      eq(sqlText(schema.jobs.payload, 'contentPackId'), String(renderPack.id))
    ))).length, 1, 'legacy processing work blocks exact rollout enqueue');
    await db.update(schema.jobs).set({
      status: schema.JobStatus.COMPLETED,
      completedAt: new Date(),
    }).where(eq(schema.jobs.id, formatJobs[0]!.id));
    await reconcileProjectPipeline(renderProject.id);
    const postRolloutJobs = await db.select().from(schema.jobs).where(and(
      eq(schema.jobs.type, schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM),
      eq(sqlText(schema.jobs.payload, 'contentPackId'), String(renderPack.id))
    ));
    assert.equal(postRolloutJobs.length, 2, 'terminal legacy work permits one exact job');
    const exactRolloutJob = postRolloutJobs.find((job) =>
      'editConfigId' in job.payload || 'renderConfigId' in job.payload
    );
    assert.ok(exactRolloutJob);
    await db.update(schema.jobs).set({
      status: schema.JobStatus.COMPLETED,
      completedAt: new Date(),
    }).where(eq(schema.jobs.id, exactRolloutJob.id));
    await reconcileProjectPipeline(renderProject.id);
    const failedArtifacts = await db.select().from(schema.renderedClips).where(
      eq(schema.renderedClips.clipCandidateId, renderCandidate.id)
    );
    assert.equal(failedArtifacts.length, 1);
    assert.equal(failedArtifacts[0]!.status, schema.RenderedClipStatus.FAILED);
    await db.delete(schema.jobs).where(eq(schema.jobs.id, exactRolloutJob.id));
    await db.update(schema.renderedClips).set({
      status: schema.RenderedClipStatus.READY,
      failureReason: null,
      storageKey: 'render-rollout-ready.mp4',
    }).where(eq(schema.renderedClips.id, failedArtifacts[0]!.id));
    await reconcileProjectPipeline(renderProject.id);
    assert.equal((await db.select().from(schema.jobs).where(and(
      eq(schema.jobs.type, schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM),
      eq(sqlText(schema.jobs.payload, 'contentPackId'), String(renderPack.id))
    ))).length, 1, 'an exact artifact satisfies a terminal legacy rollout job');

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
    await raceReconciliation(facecamProject.id);
    const facecamJobs = await db.select().from(schema.jobs).where(and(
      eq(schema.jobs.type, schema.JobType.DETECT_CLIP_FACECAM),
      eq(sqlText(schema.jobs.payload, 'clipCandidateId'), String(facecamCandidate.id)),
      eq(sqlText(schema.jobs.payload, 'contentPackId'), String(facecamPack.id))
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
    await raceReconciliation(facecamProject.id);
    const projectedCandidate = await db.query.clipCandidates.findFirst({
      where: eq(schema.clipCandidates.id, facecamCandidate.id),
    });
    assert.equal(
      projectedCandidate!.facecamDetectionStatus,
      schema.FacecamDetectionStatus.NOT_FOUND
    );
    const facecamRenderJobs = await db.select().from(schema.jobs).where(and(
      eq(schema.jobs.type, schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM),
      eq(sqlText(schema.jobs.payload, 'clipCandidateId'), String(facecamCandidate.id)),
      eq(sqlText(schema.jobs.payload, 'contentPackId'), String(facecamPack.id))
    ));
    assert.equal(facecamRenderJobs.length, 1);

    const missingRunProject = await createProject('facecam-missing-run');
    const missingRunSource = await createSource(missingRunProject.id, 'facecam-missing-run');
    const missingRunTranscript = await createReadyTranscript(missingRunSource.id);
    const missingRunPack = await createPack(
      missingRunProject.id,
      missingRunSource.id,
      missingRunTranscript.id,
      randomUUID()
    );
    await insertGenerationJob(missingRunPack);
    const missingRunCandidate = await createCandidate(missingRunPack, missingRunTranscript.id);
    await reconcileProjectPipeline(missingRunProject.id);
    const missingRunJob = await db.query.jobs.findFirst({
      where: and(
        eq(schema.jobs.type, schema.JobType.DETECT_CLIP_FACECAM),
        eq(sqlText(schema.jobs.payload, 'contentPackId'), String(missingRunPack.id))
      ),
    });
    assert.ok(missingRunJob && 'detectionRunId' in missingRunJob.payload);
    const expectedMissingRunId = missingRunJob.payload.detectionRunId!;
    await db.update(schema.jobs).set({
      status: schema.JobStatus.COMPLETED,
      completedAt: new Date(),
    }).where(eq(schema.jobs.id, missingRunJob.id));
    await db.delete(schema.clipCandidateFacecamDetectionRuns).where(
      eq(schema.clipCandidateFacecamDetectionRuns.id, expectedMissingRunId)
    );
    await reconcileProjectPipeline(missingRunProject.id);
    const missingRunProjectedCandidate = await db.query.clipCandidates.findFirst({
      where: eq(schema.clipCandidates.id, missingRunCandidate.id),
    });
    assert.equal(
      missingRunProjectedCandidate!.facecamDetectionStatus,
      schema.FacecamDetectionStatus.FAILED
    );
    assert.equal(
      missingRunProjectedCandidate!.facecamDetectionFailureReason,
      'pipeline_reconciliation:facecam_terminal_result_missing'
    );
    assert.ok(await db.query.jobs.findFirst({
      where: and(
        eq(schema.jobs.type, schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM),
        eq(sqlText(schema.jobs.payload, 'contentPackId'), String(missingRunPack.id))
      ),
    }), 'missing-run terminalization must queue the safe render projection');
    const missingRunNotificationsBefore = await db.select().from(schema.notifications).where(and(
      eq(schema.notifications.entityType, 'clip_candidate'),
      eq(schema.notifications.entityId, missingRunCandidate.id)
    ));
    assert.equal(missingRunNotificationsBefore.length, 1);
    const missingRunSnapshotBefore = await snapshotReconciliationRows();
    await reconcileProjectPipeline(missingRunProject.id);
    const missingRunSnapshotAfter = await snapshotReconciliationRows();
    assert.deepEqual(missingRunSnapshotAfter, missingRunSnapshotBefore);
    const missingRunNotificationsAfter = await db.select().from(schema.notifications).where(and(
      eq(schema.notifications.entityType, 'clip_candidate'),
      eq(schema.notifications.entityId, missingRunCandidate.id)
    ));
    assert.deepEqual(missingRunNotificationsAfter, missingRunNotificationsBefore);

    await t.test('worker and reconciler notification contention uses one durable run key', async () => {
      const project = await createProject('facecam-notification-contention');
      const source = await createSource(project.id, 'facecam-notification-contention');
      const transcript = await createReadyTranscript(source.id);
      const pack = await createPack(project.id, source.id, transcript.id, randomUUID());
      await insertGenerationJob(pack);
      const candidate = await createCandidate(pack, transcript.id);
      await reconcileProjectPipeline(project.id);
      const queued = await db.query.jobs.findFirst({
        where: and(
          eq(schema.jobs.type, schema.JobType.DETECT_CLIP_FACECAM),
          eq(sqlText(schema.jobs.payload, 'contentPackId'), String(pack.id))
        ),
      });
      assert.ok(queued && 'detectionRunId' in queued.payload);
      const leaseToken = randomUUID();
      const leaseExpiresAt = new Date(Date.now() + 60_000);
      const [claimed] = await db.update(schema.jobs).set({
        status: schema.JobStatus.PROCESSING,
        leaseToken,
        leaseExpiresAt,
        startedAt: new Date(),
      }).where(eq(schema.jobs.id, queued.id)).returning();
      let detectionPersisted!: () => void;
      let releaseWorker!: () => void;
      const persisted = new Promise<void>((resolve) => { detectionPersisted = resolve; });
      const release = new Promise<void>((resolve) => { releaseWorker = resolve; });
      const worker = processClaimedJob(claimed as never, {
        ...productionPipelineProcessingRuntime,
        processors: {
          ...productionPipelineProcessingRuntime.processors,
          detectCandidateFacecam: (async (params: { detectionRunId: number }) => {
            await db.update(schema.clipCandidateFacecamDetectionRuns).set({
              status: schema.FacecamDetectionStatus.NOT_FOUND,
              completedAt: new Date(),
            }).where(eq(schema.clipCandidateFacecamDetectionRuns.id, params.detectionRunId));
            detectionPersisted();
            await release;
            return {
              detectionRunId: params.detectionRunId,
              clipCandidateId: candidate.id,
              status: schema.FacecamDetectionStatus.NOT_FOUND,
              detectionCount: 0,
              skipped: false,
            };
          }) as never,
        },
        downstream: { trigger: () => {} },
        timer: {
          startHeartbeat: () => 1,
          stopHeartbeat: () => {},
        },
      });
      await persisted;
      await reconcileProjectPipeline(project.id);
      releaseWorker();
      await worker;
      const notifications = await db.select().from(schema.notifications).where(and(
        eq(schema.notifications.entityType, 'clip_candidate'),
        eq(schema.notifications.entityId, candidate.id)
      ));
      assert.equal(notifications.length, 1);
    });

    await t.test('worker terminal failure and reconciler use the same notification key', async () => {
      const project = await createProject('facecam-worker-failure-notification');
      const source = await createSource(project.id, 'facecam-worker-failure-notification');
      const transcript = await createReadyTranscript(source.id);
      const pack = await createPack(project.id, source.id, transcript.id, randomUUID());
      await insertGenerationJob(pack);
      const candidate = await createCandidate(pack, transcript.id);
      await reconcileProjectPipeline(project.id);
      const queued = await db.query.jobs.findFirst({
        where: and(
          eq(schema.jobs.type, schema.JobType.DETECT_CLIP_FACECAM),
          eq(sqlText(schema.jobs.payload, 'contentPackId'), String(pack.id))
        ),
      });
      assert.ok(queued);
      const leaseToken = randomUUID();
      const [claimed] = await db.update(schema.jobs).set({
        status: schema.JobStatus.PROCESSING,
        leaseToken,
        leaseExpiresAt: new Date(Date.now() + 60_000),
        startedAt: new Date(),
      }).where(eq(schema.jobs.id, queued.id)).returning();
      await processClaimedJob(claimed as never, {
        ...productionPipelineProcessingRuntime,
        processors: {
          ...productionPipelineProcessingRuntime.processors,
          detectCandidateFacecam: (async () => {
            throw new Error('deterministic facecam worker failure');
          }) as never,
        },
        downstream: { trigger: () => {} },
        timer: {
          startHeartbeat: () => 1,
          stopHeartbeat: () => {},
        },
      });
      const workerNotifications = await db.select().from(schema.notifications).where(and(
        eq(schema.notifications.entityType, 'clip_candidate'),
        eq(schema.notifications.entityId, candidate.id)
      ));
      assert.equal(workerNotifications.length, 1);
      await reconcileProjectPipeline(project.id);
      const reconciledNotifications = await db.select().from(schema.notifications).where(and(
        eq(schema.notifications.entityType, 'clip_candidate'),
        eq(schema.notifications.entityId, candidate.id)
      ));
      assert.deepEqual(reconciledNotifications, workerNotifications);
    });

    await t.test('distinct facecam runs with the same outcome have distinct notification keys', async () => {
      const project = await createProject('facecam-distinct-notifications');
      const source = await createSource(project.id, 'facecam-distinct-notifications');
      const transcript = await createReadyTranscript(source.id);
      const pack = await createPack(project.id, source.id, transcript.id, randomUUID());
      const candidate = await createCandidate(pack, transcript.id);
      await db.update(schema.clipCandidates).set({
        facecamDetectionStatus: schema.FacecamDetectionStatus.NOT_FOUND,
      }).where(eq(schema.clipCandidates.id, candidate.id));
      const [firstRun] = await db.insert(schema.clipCandidateFacecamDetectionRuns).values({
        userId: user.id,
        sourceAssetId: source.id,
        contentPackId: pack.id,
        clipCandidateId: candidate.id,
        generationRunId: pack.generationRunId,
        detectorVersion: 'facecam_v1',
        startTimeMs: candidate.startTimeMs,
        endTimeMs: candidate.endTimeMs,
        status: schema.FacecamDetectionStatus.NOT_FOUND,
      }).returning();
      const [secondRun] = await db.insert(schema.clipCandidateFacecamDetectionRuns).values({
        userId: user.id,
        sourceAssetId: source.id,
        contentPackId: pack.id,
        clipCandidateId: candidate.id,
        generationRunId: pack.generationRunId,
        detectorVersion: 'facecam_v2',
        startTimeMs: candidate.startTimeMs,
        endTimeMs: candidate.endTimeMs,
        status: schema.FacecamDetectionStatus.NOT_FOUND,
      }).returning();
      await createFacecamDetectionNotification(candidate.id, firstRun.id, db);
      await createFacecamDetectionNotification(candidate.id, secondRun.id, db);
      const notifications = await db.select().from(schema.notifications).where(and(
        eq(schema.notifications.entityType, 'clip_candidate'),
        eq(schema.notifications.entityId, candidate.id)
      ));
      assert.equal(notifications.length, 2);
      assert.notEqual(notifications[0]!.dedupeKey, notifications[1]!.dedupeKey);
    });

    await t.test('only the exact facecam run satisfies and repairs candidate projection', async () => {
      const project = await createProject('facecam-exact-run');
      const source = await createSource(project.id, 'facecam-exact-run');
      const transcript = await createReadyTranscript(source.id);
      const pack = await createPack(project.id, source.id, transcript.id, randomUUID());
      await insertGenerationJob(pack);
      const candidate = await createCandidate(pack, transcript.id);
      await reconcileProjectPipeline(project.id);
      const exactJob = await db.query.jobs.findFirst({
        where: and(
          eq(schema.jobs.type, schema.JobType.DETECT_CLIP_FACECAM),
          eq(sqlText(schema.jobs.payload, 'contentPackId'), String(pack.id))
        ),
      });
      assert.ok(exactJob && 'detectionRunId' in exactJob.payload);
      const exactRunId = exactJob.payload.detectionRunId!;
      await db.insert(schema.clipCandidateFacecamDetectionRuns).values({
        userId: user.id,
        sourceAssetId: source.id,
        contentPackId: pack.id,
        clipCandidateId: candidate.id,
        generationRunId: pack.generationRunId,
        detectorVersion: 'wrong_detector',
        startTimeMs: candidate.startTimeMs,
        endTimeMs: candidate.endTimeMs,
        status: schema.FacecamDetectionStatus.NOT_FOUND,
      });
      await db.update(schema.clipCandidates).set({
        facecamDetectionStatus: schema.FacecamDetectionStatus.NOT_FOUND,
      }).where(eq(schema.clipCandidates.id, candidate.id));
      await reconcileProjectPipeline(project.id);
      assert.equal((await db.query.clipCandidates.findFirst({
        where: eq(schema.clipCandidates.id, candidate.id),
      }))!.facecamDetectionStatus, schema.FacecamDetectionStatus.PENDING);
      assert.equal((await db.select().from(schema.jobs).where(and(
        eq(schema.jobs.type, schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM),
        eq(sqlText(schema.jobs.payload, 'contentPackId'), String(pack.id))
      ))).length, 0, 'a wrong terminal run cannot open the render gate');
      await db.update(schema.clipCandidateFacecamDetectionRuns).set({
        status: schema.FacecamDetectionStatus.NOT_FOUND,
        completedAt: new Date(),
      }).where(eq(schema.clipCandidateFacecamDetectionRuns.id, exactRunId));
      await db.update(schema.jobs).set({
        status: schema.JobStatus.COMPLETED,
        completedAt: new Date(),
      }).where(eq(schema.jobs.id, exactJob.id));
      await db.update(schema.clipCandidates).set({
        facecamDetectionStatus: schema.FacecamDetectionStatus.FAILED,
      }).where(eq(schema.clipCandidates.id, candidate.id));
      await reconcileProjectPipeline(project.id);
      assert.equal((await db.query.clipCandidates.findFirst({
        where: eq(schema.clipCandidates.id, candidate.id),
      }))!.facecamDetectionStatus, schema.FacecamDetectionStatus.NOT_FOUND);
    });

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
    await raceReconciliation(rebuildProject.id);
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
    const rebuiltGenerationJob = rebuildJobs.find((job) =>
      'contentPackId' in job.payload &&
      job.payload.contentPackId === rebuildPack.id &&
      'reconciliationRebuild' in job.payload
    );
    assert.deepEqual(
      rebuiltGenerationJob && 'reconciliationRebuild' in rebuiltGenerationJob.payload
        ? rebuiltGenerationJob.payload.reconciliationRebuild
        : null,
      {
        originalGenerationRunId: rebuildPack.generationRunId,
        reason: 'clip_candidate_missing',
      }
    );
    await db.update(schema.jobs).set({
      status: schema.JobStatus.COMPLETED,
      completedAt: new Date(),
    }).where(eq(schema.jobs.id, rebuiltGenerationJob!.id));
    await db.insert(schema.jobs).values({
      type: schema.JobType.RENDER_CLIP_CANDIDATE,
      status: schema.JobStatus.CANCELLED,
      idempotencyKey: `rebuilt-missing-candidate:${randomUUID()}`,
      payload: {
        sourceAssetId: rebuildSource.id,
        contentPackId: rebuildPack.id,
        clipCandidateId: 999_998,
        userId: user.id,
        generationRunId: rebuilt!.generationRunId,
      },
      cancellationReason: 'clip_candidate_missing',
      cancellationRequestedAt: new Date(),
      completedAt: new Date(),
    });
    await reconcileProjectPipeline(rebuildProject.id);
    const consumedPack = await db.query.contentPacks.findFirst({
      where: eq(schema.contentPacks.id, rebuildPack.id),
    });
    assert.equal(consumedPack!.status, schema.ContentPackStatus.FAILED);
    assert.match(consumedPack!.failureReason!, /rebuild_consumed/);

    const independentRun = randomUUID();
    await db.update(schema.contentPacks).set({
      generationRunId: independentRun,
      status: schema.ContentPackStatus.GENERATING,
      failureReason: null,
    }).where(eq(schema.contentPacks.id, rebuildPack.id));
    const independentPack = {
      ...rebuildPack,
      generationRunId: independentRun,
      status: schema.ContentPackStatus.GENERATING,
    };
    await insertGenerationJob(independentPack);
    await db.insert(schema.jobs).values({
      type: schema.JobType.RENDER_CLIP_CANDIDATE,
      status: schema.JobStatus.CANCELLED,
      idempotencyKey: `independent-missing-candidate:${randomUUID()}`,
      payload: {
        sourceAssetId: rebuildSource.id,
        contentPackId: rebuildPack.id,
        clipCandidateId: 999_996,
        userId: user.id,
        generationRunId: independentRun,
      },
      cancellationReason: 'clip_candidate_missing',
      cancellationRequestedAt: new Date(),
    });
    await reconcileProjectPipeline(rebuildProject.id);
    const independentRebuiltPack = await db.query.contentPacks.findFirst({
      where: eq(schema.contentPacks.id, rebuildPack.id),
    });
    assert.notEqual(
      independentRebuiltPack!.generationRunId,
      independentRun,
      'a historical marker from another root must not consume an independent lineage'
    );

    const cancelledGenerationProject = await createProject('cancelled-generation-evidence');
    const cancelledGenerationSource = await createSource(
      cancelledGenerationProject.id,
      'cancelled-generation-evidence',
      schema.SourceAssetType.YOUTUBE_URL
    );
    const cancelledGenerationTranscript = await createReadyTranscript(cancelledGenerationSource.id);
    const cancelledGenerationPack = await createPack(
      cancelledGenerationProject.id,
      cancelledGenerationSource.id,
      cancelledGenerationTranscript.id,
      randomUUID()
    );
    const cancellationRequestedGenerationJob = await insertGenerationJob(cancelledGenerationPack);
    await db.update(schema.jobs).set({ cancellationRequestedAt: new Date() })
      .where(eq(schema.jobs.id, cancellationRequestedGenerationJob.id));
    await db.insert(schema.jobs).values({
      type: schema.JobType.RENDER_CLIP_CANDIDATE,
      status: schema.JobStatus.CANCELLED,
      idempotencyKey: `cancel-request-evidence:${randomUUID()}`,
      payload: {
        sourceAssetId: cancelledGenerationSource.id,
        contentPackId: cancelledGenerationPack.id,
        clipCandidateId: 999_997,
        userId: user.id,
        generationRunId: cancelledGenerationPack.generationRunId,
      },
      cancellationReason: 'clip_candidate_missing',
      cancellationRequestedAt: new Date(),
    });
    await reconcileProjectPipeline(cancelledGenerationProject.id);
    const cancelledGenerationResult = await db.query.contentPacks.findFirst({
      where: eq(schema.contentPacks.id, cancelledGenerationPack.id),
    });
    assert.equal(cancelledGenerationResult!.generationRunId, cancelledGenerationPack.generationRunId);
    assert.equal(cancelledGenerationResult!.status, schema.ContentPackStatus.FAILED);

    await t.test('failed rebuild transaction leaves lineage unconsumed and replayable', async () => {
      const project = await createProject('rebuild-rollback');
      const source = await createSource(
        project.id,
        'rebuild-rollback',
        schema.SourceAssetType.YOUTUBE_URL
      );
      const transcript = await createReadyTranscript(source.id);
      const pack = await createPack(project.id, source.id, transcript.id, randomUUID());
      await insertGenerationJob(pack);
      await db.insert(schema.jobs).values({
        type: schema.JobType.RENDER_CLIP_CANDIDATE,
        status: schema.JobStatus.CANCELLED,
        idempotencyKey: `rebuild-rollback-evidence:${randomUUID()}`,
        payload: {
          sourceAssetId: source.id,
          contentPackId: pack.id,
          clipCandidateId: 900_001,
          userId: user.id,
          generationRunId: pack.generationRunId,
        },
        cancellationReason: 'clip_candidate_missing',
      });
      const functionName = `fail_rebuild_${pack.id}`;
      const triggerName = `fail_rebuild_trigger_${pack.id}`;
      await admin.unsafe(`
        create function "${schemaName}"."${functionName}"() returns trigger language plpgsql as $$
        begin
          if new.payload ? 'reconciliationRebuild'
            and new.payload->>'contentPackId' = '${pack.id}' then
            raise exception 'injected rebuild marker failure';
          end if;
          return new;
        end $$
      `);
      await admin.unsafe(`
        create trigger "${triggerName}" before insert on "${schemaName}".jobs
        for each row execute function "${schemaName}"."${functionName}"()
      `);
      await assert.rejects(
        reconcileProjectPipeline(project.id),
        /injected rebuild marker failure/
      );
      const rolledBackPack = await db.query.contentPacks.findFirst({
        where: eq(schema.contentPacks.id, pack.id),
      });
      assert.equal(rolledBackPack!.generationRunId, pack.generationRunId);
      assert.equal((await db.select().from(schema.jobs).where(
        eq(sqlText(schema.jobs.payload, 'contentPackId'), String(pack.id))
      )).filter((job) => 'reconciliationRebuild' in job.payload).length, 0);
      await admin.unsafe(`drop trigger "${triggerName}" on "${schemaName}".jobs`);
      await admin.unsafe(`drop function "${schemaName}"."${functionName}"()`);
      await raceReconciliation(project.id);
      const replayedPack = await db.query.contentPacks.findFirst({
        where: eq(schema.contentPacks.id, pack.id),
      });
      assert.notEqual(replayedPack!.generationRunId, pack.generationRunId);
      assert.equal((await db.select().from(schema.jobs).where(
        eq(sqlText(schema.jobs.payload, 'contentPackId'), String(pack.id))
      )).filter((job) => 'reconciliationRebuild' in job.payload).length, 1);
    });

    await t.test('unrelated and malformed rebuild markers do not consume the current lineage', async () => {
      const project = await createProject('rebuild-marker-scope');
      const source = await createSource(
        project.id,
        'rebuild-marker-scope',
        schema.SourceAssetType.YOUTUBE_URL
      );
      const transcript = await createReadyTranscript(source.id);
      const pack = await createPack(project.id, source.id, transcript.id, randomUUID());
      await insertGenerationJob(pack);
      const unrelatedPayload = {
        contentPackId: pack.id,
        sourceAssetId: source.id,
        transcriptId: transcript.id,
        userId: user.id,
        generationRunId: randomUUID(),
        reconciliationRebuild: {
          originalGenerationRunId: 'another-lineage-root',
          reason: 'clip_candidate_missing' as const,
        },
      };
      await db.insert(schema.jobs).values({
        type: schema.JobType.GENERATE_SHORT_FORM_PACK,
        status: schema.JobStatus.COMPLETED,
        idempotencyKey: buildJobIdempotencyKey(
          schema.JobType.GENERATE_SHORT_FORM_PACK,
          unrelatedPayload
        ),
        payload: unrelatedPayload,
      });
      await db.insert(schema.jobs).values({
        type: schema.JobType.GENERATE_SHORT_FORM_PACK,
        status: schema.JobStatus.COMPLETED,
        idempotencyKey: `malformed-rebuild-marker:${randomUUID()}`,
        payload: {
          ...unrelatedPayload,
          generationRunId: randomUUID(),
          reconciliationRebuild: {
            originalGenerationRunId: pack.generationRunId,
            reason: 'wrong_reason',
          },
        } as never,
      });
      await db.insert(schema.jobs).values({
        type: schema.JobType.RENDER_CLIP_CANDIDATE,
        status: schema.JobStatus.CANCELLED,
        idempotencyKey: `marker-scope-evidence:${randomUUID()}`,
        payload: {
          sourceAssetId: source.id,
          contentPackId: pack.id,
          clipCandidateId: 900_002,
          userId: user.id,
          generationRunId: pack.generationRunId,
        },
        cancellationReason: 'clip_candidate_missing',
      });
      const events = await reconcileProjectPipeline(project.id);
      assert.ok(events.some((item) => item.reason === 'job_payload_malformed'));
      assert.notEqual((await db.query.contentPacks.findFirst({
        where: eq(schema.contentPacks.id, pack.id),
      }))!.generationRunId, pack.generationRunId);
    });

    await t.test('production pack finalization sets ready', async () => {
      const result = await createFinalizedPack('pack-final-ready', [
        schema.RenderedClipStatus.READY,
      ]);
      assert.equal(result.pack!.status, schema.ContentPackStatus.READY);
    });

    await t.test('production pack finalization sets partially_ready', async () => {
      const result = await createFinalizedPack('pack-final-partial', [
        schema.RenderedClipStatus.READY,
        schema.RenderedClipStatus.FAILED,
      ]);
      assert.equal(result.pack!.status, schema.ContentPackStatus.PARTIALLY_READY);
    });

    await t.test('production pack finalization sets failed', async () => {
      const result = await createFinalizedPack('pack-final-failed', [
        schema.RenderedClipStatus.FAILED,
      ]);
      assert.equal(result.pack!.status, schema.ContentPackStatus.FAILED);
      assert.match(result.pack!.failureReason!, /pack_outputs_failed/);
    });

    await t.test('two reconcilers create one exact job when a legacy blocker becomes terminal', async () => {
      const project = await createProject('legacy-transition-race');
      const source = await createSource(
        project.id,
        'legacy-transition-race',
        schema.SourceAssetType.YOUTUBE_URL
      );
      const transcript = await createReadyTranscript(source.id);
      const pack = await createPack(project.id, source.id, transcript.id, randomUUID());
      await insertGenerationJob(pack);
      const candidate = await createCandidate(pack, transcript.id);
      await reconcileProjectPipeline(project.id);
      const exact = await db.query.jobs.findFirst({
        where: and(
          eq(schema.jobs.type, schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM),
          eq(sqlText(schema.jobs.payload, 'contentPackId'), String(pack.id))
        ),
      });
      assert.ok(exact);
      const legacy = { ...exact.payload } as Record<string, unknown>;
      delete legacy.editConfigId;
      delete legacy.renderConfigId;
      await db.update(schema.jobs).set({
        status: schema.JobStatus.PROCESSING,
        idempotencyKey: `legacy-transition:${randomUUID()}`,
        payload: legacy as never,
      }).where(eq(schema.jobs.id, exact.id));
      await raceReconciliation(project.id, async () => {
        await db.update(schema.jobs).set({
          status: schema.JobStatus.COMPLETED,
          completedAt: new Date(),
        }).where(eq(schema.jobs.id, exact.id));
      });
      const jobsForConfig = await db.select().from(schema.jobs).where(and(
        eq(schema.jobs.type, schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM),
        eq(sqlText(schema.jobs.payload, 'clipCandidateId'), String(candidate.id)),
        eq(sqlText(schema.jobs.payload, 'contentPackId'), String(pack.id))
      ));
      assert.equal(jobsForConfig.length, 2);
      assert.equal(jobsForConfig.filter((job) =>
        'editConfigId' in job.payload || 'renderConfigId' in job.payload
      ).length, 1);
    });

    await t.test('production apply refuses a superseded generation job', async () => {
      const project = await createProject('superseded-generation-apply');
      const source = await createSource(
        project.id,
        'superseded-generation-apply',
        schema.SourceAssetType.YOUTUBE_URL
      );
      const transcript = await createReadyTranscript(source.id);
      const pack = await createPack(project.id, source.id, transcript.id, randomUUID());
      await insertGenerationJob({ ...pack, generationRunId: randomUUID() });
      const events = await reconcileProjectPipeline(project.id);
      assert.ok(events.some((item) =>
        item.reason === 'generation_superseded' && item.action === 'refuse'
      ));
      assert.equal((await db.query.contentPacks.findFirst({
        where: eq(schema.contentPacks.id, pack.id),
      }))!.generationRunId, pack.generationRunId);
    });

    await t.test('reconciliation versus project deletion is serialized by the project row', async () => {
      const project = await createProject('project-deletion-race');
      await createSource(project.id, 'project-deletion-race');
      await raceDeletionWithReconciliation(project.id, async () =>
        await deleteProjectGraph({
          projectId: project.id,
          userId: user.id,
          deleteStorageObject: async () => {},
          abortMultipartUpload: async () => {},
        })
      );
      assert.equal(await db.query.projects.findFirst({
        where: eq(schema.projects.id, project.id),
      }), undefined);
    });

    await t.test('reconciliation versus source deletion is serialized by lifecycle locks', async () => {
      const project = await createProject('source-deletion-race');
      const source = await createSource(project.id, 'source-deletion-race');
      await raceDeletionWithReconciliation(project.id, async () =>
        await deleteSourceAssetGraph({
          projectId: project.id,
          sourceAssetId: source.id,
          userId: user.id,
          deleteStorageObject: async () => {},
          abortMultipartUpload: async () => {},
        })
      );
      assert.equal(await db.query.sourceAssets.findFirst({
        where: eq(schema.sourceAssets.id, source.id),
      }), undefined);
    });

    await t.test('reconciliation versus authorized worker finalization is serialized', async () => {
      const project = await createProject('worker-finalization-race');
      const source = await createSource(
        project.id,
        'worker-finalization-race',
        schema.SourceAssetType.YOUTUBE_URL
      );
      const leaseToken = randomUUID();
      const [job] = await db.insert(schema.jobs).values({
        type: schema.JobType.INGEST_YOUTUBE_SOURCE_ASSET,
        status: schema.JobStatus.PROCESSING,
        idempotencyKey: `ingest_youtube_source_asset:source:${source.id}:v1`,
        payload: { sourceAssetId: source.id, userId: user.id },
        leaseToken,
        leaseExpiresAt: new Date(Date.now() + 60_000),
        startedAt: new Date(),
      }).returning();
      await raceDeletionWithReconciliation(project.id, async () =>
        await withAuthorizedJobCompletion({ jobId: job.id, leaseToken }, async (tx) => {
          await tx.insert(schema.transcripts).values({
            userId: user.id,
            sourceAssetId: source.id,
            content: 'Worker persisted durable transcript content.',
            status: schema.TranscriptStatus.READY,
          });
          await tx.update(schema.sourceAssets).set({
            status: schema.SourceAssetStatus.READY,
          }).where(eq(schema.sourceAssets.id, source.id));
        })
      );
      const finalized = await db.query.jobs.findFirst({ where: eq(schema.jobs.id, job.id) });
      assert.equal(finalized!.status, schema.JobStatus.COMPLETED);
      assert.equal((await db.select().from(schema.transcripts).where(
        eq(schema.transcripts.sourceAssetId, source.id)
      )).length, 1);
    });

    const deletingProject = await createProject('deleting');
    const deletingSource = await createSource(deletingProject.id, 'deleting');
    await db.update(schema.projects).set({ deletionRequestedAt: new Date() })
      .where(eq(schema.projects.id, deletingProject.id));
    const refusal = await reconcileProjectPipeline(deletingProject.id);
    assert.deepEqual(refusal.map((item) => item.reason), ['project_deleting']);
    assert.equal((await db.select().from(schema.jobs).where(
      eq(sqlText(schema.jobs.payload, 'sourceAssetId'), String(deletingSource.id))
    )).length, 0);

    await t.test('transaction failure rolls back attempted repair and replay succeeds once', async () => {
      const project = await createProject('repair-rollback');
      const source = await createSource(project.id, 'repair-rollback');
      const functionName = `fail_repair_${source.id}`;
      const triggerName = `fail_repair_trigger_${source.id}`;
      await admin.unsafe(`
        create function "${schemaName}"."${functionName}"() returns trigger language plpgsql as $$
        begin
          if new.payload->>'sourceAssetId' = '${source.id}' then
            raise exception 'injected reconciliation repair failure';
          end if;
          return new;
        end $$
      `);
      await admin.unsafe(`
        create trigger "${triggerName}" before insert on "${schemaName}".jobs
        for each row execute function "${schemaName}"."${functionName}"()
      `);
      const beforeSource = await db.query.sourceAssets.findFirst({
        where: eq(schema.sourceAssets.id, source.id),
      });
      await assert.rejects(
        reconcileProjectPipeline(project.id),
        /injected reconciliation repair failure/
      );
      assert.deepEqual(await db.query.sourceAssets.findFirst({
        where: eq(schema.sourceAssets.id, source.id),
      }), beforeSource);
      assert.equal((await db.select().from(schema.transcripts).where(
        eq(schema.transcripts.sourceAssetId, source.id)
      )).length, 0);
      assert.equal((await db.select().from(schema.jobs).where(
        eq(sqlText(schema.jobs.payload, 'sourceAssetId'), String(source.id))
      )).length, 0);
      await admin.unsafe(`drop trigger "${triggerName}" on "${schemaName}".jobs`);
      await admin.unsafe(`drop function "${schemaName}"."${functionName}"()`);
      await reconcileProjectPipeline(project.id);
      await reconcileProjectPipeline(project.id);
      assert.equal((await db.select().from(schema.jobs).where(
        eq(sqlText(schema.jobs.payload, 'sourceAssetId'), String(source.id))
      )).length, 1);
    });

    await t.test('page failure returns no cursor and retry does not skip the failed project', async () => {
      const cursorRows = await db.select({ id: schema.projects.id }).from(schema.projects)
        .orderBy(sql`${schema.projects.id} desc`).limit(1);
      const priorCursor = cursorRows[0]!.id;
      const firstProject = await createProject('page-retry-first');
      const firstSource = await createSource(firstProject.id, 'page-retry-first');
      const failedProject = await createProject('page-retry-failed');
      const failedSource = await createSource(failedProject.id, 'page-retry-failed');
      const functionName = `fail_page_${failedSource.id}`;
      const triggerName = `fail_page_trigger_${failedSource.id}`;
      await admin.unsafe(`
        create function "${schemaName}"."${functionName}"() returns trigger language plpgsql as $$
        begin
          if new.payload->>'sourceAssetId' = '${failedSource.id}' then
            raise exception 'injected reconciliation page failure';
          end if;
          return new;
        end $$
      `);
      await admin.unsafe(`
        create trigger "${triggerName}" before insert on "${schemaName}".jobs
        for each row execute function "${schemaName}"."${functionName}"()
      `);
      await assert.rejects(
        reconcilePipelinePage({ afterProjectId: priorCursor, pageSize: 2 }),
        /injected reconciliation page failure/
      );
      assert.equal((await db.select().from(schema.jobs).where(
        eq(sqlText(schema.jobs.payload, 'sourceAssetId'), String(firstSource.id))
      )).length, 1);
      assert.equal((await db.select().from(schema.jobs).where(
        eq(sqlText(schema.jobs.payload, 'sourceAssetId'), String(failedSource.id))
      )).length, 0);
      await admin.unsafe(`drop trigger "${triggerName}" on "${schemaName}".jobs`);
      await admin.unsafe(`drop function "${schemaName}"."${functionName}"()`);
      const replayedPage = await reconcilePipelinePage({
        afterProjectId: priorCursor,
        pageSize: 2,
      });
      assert.deepEqual(replayedPage.projectIds, [firstProject.id, failedProject.id]);
      assert.equal((await db.select().from(schema.jobs).where(
        eq(sqlText(schema.jobs.payload, 'sourceAssetId'), String(firstSource.id))
      )).length, 1);
      assert.equal((await db.select().from(schema.jobs).where(
        eq(sqlText(schema.jobs.payload, 'sourceAssetId'), String(failedSource.id))
      )).length, 1);
    });

    const paging = await reconcilePipelinePage({
      afterProjectId: completedMissingProject.id,
      pageSize: 1,
    });
    assert.deepEqual(paging.projectIds, [emptyTranscriptProject.id]);
    assert.equal(paging.nextAfterProjectId, emptyTranscriptProject.id);
    assert.equal((await reconcilePipelinePage({ pageSize: 500 })).projectIds.length <= 50, true);

    await t.test('repeated reconciliation leaves every relevant row unchanged', async () => {
      await reconcileProjectPipeline(renderProject.id);
      const before = await snapshotReconciliationRows();
      await reconcileProjectPipeline(renderProject.id);
      const after = await snapshotReconciliationRows();
      assert.deepEqual(after, before);
    });
  } finally {
    await appClient?.end();
    await admin.unsafe(`drop schema if exists "${schemaName}" cascade`);
    await admin.end();
  }
});

function sqlText(column: SQLWrapper, key: string) {
  return sql<string>`${column}->>${key}`;
}
