import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { register } from 'node:module';
import test from 'node:test';

import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';

import { assertDisposablePostgresTestDatabase } from '../db/test-database-guard.ts';

register('../test/typescript-path-loader.mjs', import.meta.url);

test('snapshot pipeline lifecycle persists one authoritative render configuration', {
  skip: !process.env.PHASE1A_TEST_DATABASE_URL,
}, async (t) => {
  const configuredUrl = process.env.PHASE1A_TEST_DATABASE_URL!;
  assertDisposablePostgresTestDatabase(configuredUrl);
  const schemaName = `snapshot_lifecycle_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(configuredUrl, { max: 1 });
  let appClient: { end(): Promise<void> } | undefined;

  try {
    await admin.unsafe(`create schema "${schemaName}"`);
    await admin.unsafe(`set search_path to "${schemaName}"`);
    const migrationDirectory = new URL('../db/migrations/', import.meta.url);
    for (const file of (await readdir(migrationDirectory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
      const migration = await readFile(new URL(file, migrationDirectory), 'utf8');
      for (const statement of migration.split('--> statement-breakpoint')) {
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
    const { materializeGenerationSnapshot } = await import('./generation-snapshot.ts');
    const { insertGenerationRun } = await import('./generation-run-service.ts');
    const { activateSnapshotShortFormGeneration } = await import('./snapshot-generation-activation-service.ts');
    const { resolveCandidateEffectiveRenderConfig } = await import('./effective-render-config-service.ts');
    const { detectCandidateFacecam, getFacecamDetectionForRender } = await import('./facecam-detection-service.ts');
    const { enqueueDetectCandidateFacecamJob } = await import('./job-service.ts');
    const { enqueueShortFormPackJob } = await import('./job-service.ts');
    const { reconcileShortFormContentPackStatus } = await import('./short-form-service.ts');
    const { reconcileProjectPipeline } = await import('./pipeline-reconciliation-service.ts');
    const { assertRenderedClipPublicationAuthority } = await import('./publishing-service.ts');
    const { saveCurrentRenderedClipMedia } = await import('./media-retention-service.ts');
    const { applyBrandTemplateToClip } = await import('./brand-template-service.ts');
    const { replayCandidateFacecamTerminalProjection } = await import('./candidate-facecam-terminal-service.ts');
    const { ensureRenderedClipPending, markRenderedClipFailed } = await import('./rendered-clip-service.ts');
    const { processClaimedJob, productionPipelineProcessingRuntime } = await import('./pipeline-service.ts');
    const { assertJobExecutionAuthorized, withAuthorizedJobSuccessTransaction } = await import('./job-execution-authorization.ts');

    const [user] = await db.insert(schema.users).values({ name: 'Snapshot lifecycle user', email: `snapshot-life-${randomUUID()}@example.test`, passwordHash: 'test' }).returning();
    const [project] = await db.insert(schema.projects).values({ userId: user.id, name: 'Snapshot lifecycle project', isSaved: true }).returning();
    const [source] = await db.insert(schema.sourceAssets).values({ userId: user.id, projectId: project.id, title: 'Source', assetType: schema.SourceAssetType.UPLOADED_FILE, mimeType: 'video/mp4', storageKey: `snapshot-life/${randomUUID()}.mp4`, storageUrl: 'storage://source', status: schema.SourceAssetStatus.READY }).returning();
    const [transcript] = await db.insert(schema.transcripts).values({ userId: user.id, sourceAssetId: source.id, content: 'Grounded source text.', status: schema.TranscriptStatus.READY }).returning();
    const [template] = await db.insert(schema.brandTemplates).values({ userId: user.id, name: 'Immutable template', defaultLayout: schema.RenderedClipLayout.FACECAM_TOP_30, captionHighlightColor: '#123456', cropSettings: { sourceCrop: '4_3', captionHighlightEnabled: true }, isDefault: true }).returning();
    const generationRunId = randomUUID();
    const [pack] = await db.insert(schema.contentPacks).values({ userId: user.id, projectId: project.id, sourceAssetId: source.id, transcriptId: transcript.id, kind: schema.ContentPackKind.SHORT_FORM_CLIPS, name: 'Snapshot pack', generationRunId, shortFormGenerationMode: 'snapshot' }).returning();
    const snapshot = materializeGenerationSnapshot({
      brandTemplateId: template.id,
      ranking: { generationInstructions: 'Find clips.', clipLength: '30-60s', autoHookEnabled: true, contentPackage: 'clips_only' },
      facecam: { detectionEnabled: true, detectorVersion: 'snapshot-detector-v1', preferredLayout: schema.RenderedClipLayout.FACECAM_TOP_30, fallbackLayout: schema.RenderedClipLayout.DEFAULT },
      render: { aspectRatio: '9_16', captionsEnabled: true, captionStyle: 'default', captionFontAssetId: null, captionFontFamily: null, captionFontColor: '#ffffff', captionHighlightColor: '#facc15', captionPosition: 'bottom', captionAnimation: 'none', overlayLogoAssetId: null, introVideoAssetId: null, outroVideoAssetId: null, ctaUrl: 'https://example.test/cta', cropSettings: { sourceCrop: 'original' }, autoEditPreset: 'snapshot_preset' },
    });
    await insertGenerationRun({ generationRunId, contentPackId: pack.id, selectedBrandTemplateId: template.id, snapshot }, db);

    const makeCandidate = async (rank: number, target = { pack, generationRunId }) => (await db.insert(schema.clipCandidates).values({
      userId: user.id, contentPackId: target.pack.id, sourceAssetId: source.id, transcriptId: transcript.id, rank,
      startTimeMs: rank * 10_000, endTimeMs: rank * 10_000 + 8_000, durationMs: 8_000,
      hook: 'Hook', title: `Candidate ${rank}`, captionCopy: 'Caption', summary: 'Summary', transcriptExcerpt: 'Excerpt', whyItWorks: 'Why', platformFit: 'Fit', confidence: 90, generationRunId: target.generationRunId,
      facecamDetectionStatus: schema.FacecamDetectionStatus.NOT_FOUND,
    }).returning())[0]!;
    const resolve = (candidate: { id: number; contentPackId: number; sourceAssetId: number; userId: number; generationRunId: string }) => resolveCandidateEffectiveRenderConfig({ clipCandidateId: candidate.id, contentPackId: candidate.contentPackId, sourceAssetId: candidate.sourceAssetId, userId: candidate.userId, generationRunId: candidate.generationRunId, facecamStatus: schema.FacecamDetectionStatus.NOT_FOUND });
    const artifactFor = async (candidate: { id: number; title: string; startTimeMs: number; endTimeMs: number; durationMs: number }, config: { id: number; contentPackId: number; sourceAssetId: number; generationRunId: string; layout: string; configHash: string }, status: string) =>
      (await db.insert(schema.renderedClips).values({
        userId: user.id, contentPackId: config.contentPackId, sourceAssetId: config.sourceAssetId, clipCandidateId: candidate.id,
        generationRunId: config.generationRunId, variant: schema.RenderedClipVariant.VERTICAL_SHORT_FORM, layout: config.layout,
        clipRenderConfigId: config.id, editConfigHash: config.configHash, status, title: candidate.title,
        startTimeMs: candidate.startTimeMs, endTimeMs: candidate.endTimeMs, durationMs: candidate.durationMs,
        ...(status === schema.RenderedClipStatus.READY ? { storageKey: `snapshot/${randomUUID()}.mp4`, storageUrl: 'storage://ready', mimeType: 'video/mp4' } : { failureReason: 'terminal_failure' }),
      }).returning())[0]!;
    const exactRenderJobs = async (candidateId: number, renderConfigId: number) =>
      (await db.select().from(schema.jobs).where(eq(schema.jobs.type, schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM)))
        .filter((job) => {
          const payload = job.payload as { clipCandidateId?: number; renderConfigId?: number };
          return payload.clipCandidateId === candidateId && payload.renderConfigId === renderConfigId;
        });
    const createSnapshotPack = async (name: string) => {
      const runId = randomUUID();
      const [targetPack] = await db.insert(schema.contentPacks).values({ userId: user.id, projectId: project.id, sourceAssetId: source.id, transcriptId: transcript.id, kind: schema.ContentPackKind.SHORT_FORM_CLIPS, name, generationRunId: runId, shortFormGenerationMode: 'snapshot' }).returning();
      await insertGenerationRun({ generationRunId: runId, contentPackId: targetPack!.id, selectedBrandTemplateId: template.id, snapshot }, db);
      return { pack: targetPack!, generationRunId: runId };
    };
    const snapshotRenderConfig = (projection: Awaited<ReturnType<typeof replayCandidateFacecamTerminalProjection>>) => {
      assert.ok(projection.renderConfigs);
      return projection.renderConfigs[0]!;
    };

    await t.test('snapshot activation uses the built-in facecam layout only when no template is selected', async () => {
      const [noTemplateSource] = await db.insert(schema.sourceAssets).values({
        userId: user.id,
        projectId: project.id,
        title: 'No-template source',
        assetType: schema.SourceAssetType.UPLOADED_FILE,
        mimeType: 'video/mp4',
        storageKey: `snapshot-life/${randomUUID()}.mp4`,
        storageUrl: 'storage://no-template-source',
        status: schema.SourceAssetStatus.READY,
      }).returning();
      const [noTemplateTranscript] = await db.insert(schema.transcripts).values({
        userId: user.id,
        sourceAssetId: noTemplateSource!.id,
        content: 'Grounded no-template source text.',
        status: schema.TranscriptStatus.READY,
      }).returning();
      const activation = await activateSnapshotShortFormGeneration({
        projectId: project.id,
        sourceAssetId: noTemplateSource!.id,
        userId: user.id,
        contentPackage: 'clips_only',
        facecamDetectionEnabled: false,
      });

      assert.equal(activation.snapshot.brandTemplateId, null);
      assert.equal(activation.snapshot.facecam.detectionEnabled, true);
      assert.equal(activation.snapshot.facecam.preferredLayout, schema.RenderedClipLayout.FACECAM_TOP_30);
      assert.equal(activation.snapshot.facecam.detectorVersion, 'facecam_v2');
      assert.equal(activation.snapshot.facecam.fallbackLayout, schema.RenderedClipLayout.DEFAULT);
      assert.equal(activation.snapshot.render.captionsEnabled, true);
      assert.equal(activation.snapshot.render.captionFontColor, '#ffffff');
      assert.equal(activation.snapshot.render.captionPosition, 'bottom');
      assert.equal(activation.snapshot.render.captionAnimation, 'none');
      assert.equal(activation.snapshot.render.captionFontAssetId, null);
      assert.equal(activation.snapshot.render.overlayLogoAssetId, null);
      assert.equal(activation.snapshot.render.ctaUrl, null);
      assert.deepEqual(activation.snapshot.render.cropSettings, {
        sourceCrop: 'original',
        captionHighlightEnabled: false,
      });

      const candidate = (await db.insert(schema.clipCandidates).values({
        userId: user.id,
        contentPackId: activation.contentPack.id,
        sourceAssetId: noTemplateSource!.id,
        transcriptId: noTemplateTranscript!.id,
        rank: 1,
        startTimeMs: 1_000,
        endTimeMs: 9_000,
        durationMs: 8_000,
        hook: 'Hook',
        title: 'No-template candidate',
        captionCopy: 'Caption',
        summary: 'Summary',
        transcriptExcerpt: 'Excerpt',
        whyItWorks: 'Why',
        platformFit: 'Fit',
        confidence: 90,
        generationRunId: activation.generationRunId,
        facecamDetectionStatus: schema.FacecamDetectionStatus.READY,
      }).returning())[0]!;
      const [detectionRun] = await db.insert(schema.clipCandidateFacecamDetectionRuns).values({
        userId: user.id,
        sourceAssetId: noTemplateSource!.id,
        contentPackId: activation.contentPack.id,
        clipCandidateId: candidate.id,
        generationRunId: activation.generationRunId,
        detectorVersion: activation.snapshot.facecam.detectorVersion,
        startTimeMs: candidate.startTimeMs,
        endTimeMs: candidate.endTimeMs,
        status: schema.FacecamDetectionStatus.READY,
      }).returning();
      const [detection] = await db.insert(schema.clipCandidateFacecamDetections).values({
        userId: user.id,
        sourceAssetId: noTemplateSource!.id,
        clipCandidateId: candidate.id,
        detectionRunId: detectionRun!.id,
        generationRunId: activation.generationRunId,
        detectorVersion: activation.snapshot.facecam.detectorVersion,
        rank: 1,
        startTimeMs: candidate.startTimeMs,
        endTimeMs: candidate.endTimeMs,
        frameWidth: 1920,
        frameHeight: 1080,
        xPx: 0,
        yPx: 0,
        widthPx: 600,
        heightPx: 400,
        confidence: 99,
        sampledFrameCount: 1,
      }).returning();
      const usable = await resolveCandidateEffectiveRenderConfig({
        clipCandidateId: candidate.id,
        contentPackId: activation.contentPack.id,
        sourceAssetId: noTemplateSource!.id,
        userId: user.id,
        generationRunId: activation.generationRunId,
        facecamStatus: schema.FacecamDetectionStatus.READY,
        facecamDetectionId: detection!.id,
      });
      assert.equal(usable.config.layout, schema.RenderedClipLayout.FACECAM_TOP_30);
      assert.equal(usable.config.layoutRatio, '30_70');

      const [fallbackCandidate] = await db.insert(schema.clipCandidates).values({
        userId: user.id,
        contentPackId: activation.contentPack.id,
        sourceAssetId: noTemplateSource!.id,
        transcriptId: noTemplateTranscript!.id,
        rank: 2,
        startTimeMs: 10_000,
        endTimeMs: 18_000,
        durationMs: 8_000,
        hook: 'Hook',
        title: 'No-template fallback candidate',
        captionCopy: 'Caption',
        summary: 'Summary',
        transcriptExcerpt: 'Excerpt',
        whyItWorks: 'Why',
        platformFit: 'Fit',
        confidence: 90,
        generationRunId: activation.generationRunId,
        facecamDetectionStatus: schema.FacecamDetectionStatus.NOT_FOUND,
      }).returning();
      const fallback = await resolveCandidateEffectiveRenderConfig({
        clipCandidateId: fallbackCandidate!.id,
        contentPackId: activation.contentPack.id,
        sourceAssetId: noTemplateSource!.id,
        userId: user.id,
        generationRunId: activation.generationRunId,
        facecamStatus: schema.FacecamDetectionStatus.NOT_FOUND,
      });
      assert.equal(fallback.config.aspectRatio, '9_16');
      assert.equal(fallback.config.layout, schema.RenderedClipLayout.DEFAULT);
      assert.equal(fallback.config.layoutRatio, null);

      const selectedTemplateActivation = await activateSnapshotShortFormGeneration({
        projectId: project.id,
        sourceAssetId: noTemplateSource!.id,
        userId: user.id,
        brandTemplateId: template.id,
        contentPackage: 'clips_only',
      });
      assert.equal(selectedTemplateActivation.snapshot.render.captionHighlightColor, '#123456');
      assert.deepEqual(selectedTemplateActivation.snapshot.render.cropSettings, {
        sourceCrop: '4_3',
        captionHighlightEnabled: true,
      });
    });

    await t.test('snapshot saves only the current artifact and brand-template rerender is closed', async () => {
      const candidate = await makeCandidate(90);
      const first = await resolve(candidate);
      const [currentConfig] = await db.insert(schema.clipRenderConfigs).values({
        userId: user.id,
        contentPackId: pack.id,
        sourceAssetId: source.id,
        clipCandidateId: candidate.id,
        generationRunId,
        configHash: `current-${randomUUID()}`,
      }).returning();
      await db.update(schema.clipCandidates)
        .set({ currentRenderConfigId: currentConfig!.id })
        .where(eq(schema.clipCandidates.id, candidate.id));
      const historical = await artifactFor(candidate, first.config, schema.RenderedClipStatus.READY);
      const current = await artifactFor(candidate, currentConfig!, schema.RenderedClipStatus.READY);

      const result = await saveCurrentRenderedClipMedia({
        clipCandidateId: candidate.id,
        renderedClipId: current.id,
        renderConfigId: currentConfig!.id,
      }, user.id);
      assert.equal(result.savedCount, 1);
      const [savedHistorical, savedCurrent] = await Promise.all([
        db.query.renderedClips.findFirst({ where: (row, { eq }) => eq(row.id, historical.id) }),
        db.query.renderedClips.findFirst({ where: (row, { eq }) => eq(row.id, current.id) }),
      ]);
      assert.notEqual(savedHistorical!.retentionStatus, schema.MediaRetentionStatus.SAVED);
      assert.equal(savedCurrent!.retentionStatus, schema.MediaRetentionStatus.SAVED);
      await assert.rejects(
        saveCurrentRenderedClipMedia({
          clipCandidateId: candidate.id,
          renderedClipId: historical.id,
          renderConfigId: first.config.id,
        }, user.id),
        /rendered_clip_not_current/
      );

      const beforeConfigs = await db.select().from(schema.clipRenderConfigs)
        .where(eq(schema.clipRenderConfigs.clipCandidateId, candidate.id));
      const beforeJobs = await db.select().from(schema.jobs);
      const beforeCandidate = await db.query.clipCandidates.findFirst({
        where: (row, { eq }) => eq(row.id, candidate.id),
      });
      await assert.rejects(
        applyBrandTemplateToClip({ templateId: template.id, clipCandidateId: candidate.id, userId: user.id }),
        /snapshot_rerender_not_activated/
      );
      const afterConfigs = await db.select().from(schema.clipRenderConfigs)
        .where(eq(schema.clipRenderConfigs.clipCandidateId, candidate.id));
      const afterJobs = await db.select().from(schema.jobs);
      const afterCandidate = await db.query.clipCandidates.findFirst({
        where: (row, { eq }) => eq(row.id, candidate.id),
      });
      assert.equal(afterConfigs.length, beforeConfigs.length);
      assert.equal(afterJobs.length, beforeJobs.length);
      assert.equal(afterCandidate!.currentRenderConfigId, beforeCandidate!.currentRenderConfigId);
      assert.equal(afterCandidate!.generationRunId, beforeCandidate!.generationRunId);
    });

    await t.test('legacy Save and brand-template apply retain their previous behavior', async () => {
      const legacyTarget = await createSnapshotPack('Legacy compatibility pack');
      await db.update(schema.contentPacks)
        .set({ shortFormGenerationMode: 'legacy' })
        .where(eq(schema.contentPacks.id, legacyTarget.pack.id));
      const candidate = await makeCandidate(91, legacyTarget);
      const createLegacyArtifact = (storageKey: string) => db.insert(schema.renderedClips).values({
        userId: user.id,
        contentPackId: legacyTarget.pack.id,
        sourceAssetId: source.id,
        clipCandidateId: candidate.id,
        generationRunId: legacyTarget.generationRunId,
        variant: schema.RenderedClipVariant.VERTICAL_SHORT_FORM,
        layout: schema.RenderedClipLayout.DEFAULT,
        editConfigHash: randomUUID(),
        status: schema.RenderedClipStatus.READY,
        title: candidate.title,
        startTimeMs: candidate.startTimeMs,
        endTimeMs: candidate.endTimeMs,
        durationMs: candidate.durationMs,
        storageKey,
      }).returning();
      const [firstArtifact] = await createLegacyArtifact(`legacy/${randomUUID()}.mp4`);
      const [secondArtifact] = await createLegacyArtifact(`legacy/${randomUUID()}.mp4`);
      const saved = await saveCurrentRenderedClipMedia({
        clipCandidateId: candidate.id,
        renderedClipId: firstArtifact!.id,
      }, user.id);
      assert.equal(saved.savedCount, 2);
      const [savedFirst, savedSecond] = await Promise.all([
        db.query.renderedClips.findFirst({ where: (row, { eq }) => eq(row.id, firstArtifact!.id) }),
        db.query.renderedClips.findFirst({ where: (row, { eq }) => eq(row.id, secondArtifact!.id) }),
      ]);
      assert.equal(savedFirst!.retentionStatus, schema.MediaRetentionStatus.SAVED);
      assert.equal(savedSecond!.retentionStatus, schema.MediaRetentionStatus.SAVED);
      const applied = await applyBrandTemplateToClip({
        templateId: template.id,
        clipCandidateId: candidate.id,
        userId: user.id,
      });
      assert.ok(applied.renderConfigs.length > 0);
    });

    await t.test('snapshot immutability and resolver idempotency', async () => {
      const candidate = await makeCandidate(1);
      await db.update(schema.brandTemplates).set({ aspectRatio: '16_9', defaultLayout: schema.RenderedClipLayout.FACECAM_TOP_50, ctaUrl: 'https://mutable.example.test' }).where(eq(schema.brandTemplates.id, template.id));
      await db.insert(schema.clipEditConfigs).values({ userId: user.id, contentPackId: pack.id, sourceAssetId: source.id, clipCandidateId: candidate.id, generationRunId, captionsEnabled: false, layout: schema.RenderedClipLayout.FACECAM_TOP_50, cropSettings: { sourceCrop: 'center' }, ctaUrl: 'https://mutable.example.test', configHash: randomUUID() });
      const first = await resolve(candidate);
      const second = await resolve(candidate);
      assert.equal(first.config.id, second.config.id);
      assert.equal(first.config.aspectRatio, '9_16');
      assert.equal(first.config.captionsEnabled, true);
      assert.equal(first.config.ctaUrl, 'https://example.test/cta');
      assert.equal(first.config.layout, schema.RenderedClipLayout.DEFAULT);
      const configs = await db.select().from(schema.clipRenderConfigs).where(eq(schema.clipRenderConfigs.clipCandidateId, candidate.id));
      const jobs = await db.select().from(schema.jobs).where(eq(schema.jobs.idempotencyKey, first.job.idempotencyKey));
      const [persisted] = await db.select().from(schema.clipCandidates).where(eq(schema.clipCandidates.id, candidate.id));
      assert.equal(configs.length, 1);
      assert.equal(jobs.length, 1);
      assert.equal(persisted!.currentRenderConfigId, first.config.id);
    });

    await t.test('usable facecam has one preferred authoritative config; mismatches fail closed', async () => {
      const candidate = await makeCandidate(2);
      await db.update(schema.clipCandidates).set({ facecamDetectionStatus: schema.FacecamDetectionStatus.READY }).where(eq(schema.clipCandidates.id, candidate.id));
      const [run] = await db.insert(schema.clipCandidateFacecamDetectionRuns).values({ userId: user.id, sourceAssetId: source.id, contentPackId: pack.id, clipCandidateId: candidate.id, generationRunId, detectorVersion: 'snapshot-detector-v1', startTimeMs: candidate.startTimeMs, endTimeMs: candidate.endTimeMs, status: schema.FacecamDetectionStatus.READY }).returning();
      const [detection] = await db.insert(schema.clipCandidateFacecamDetections).values({ userId: user.id, sourceAssetId: source.id, clipCandidateId: candidate.id, detectionRunId: run.id, generationRunId, detectorVersion: 'snapshot-detector-v1', rank: 1, startTimeMs: candidate.startTimeMs, endTimeMs: candidate.endTimeMs, frameWidth: 1920, frameHeight: 1080, xPx: 0, yPx: 0, widthPx: 600, heightPx: 400, confidence: 99, sampledFrameCount: 1 }).returning();
      const resolved = await resolveCandidateEffectiveRenderConfig({ clipCandidateId: candidate.id, contentPackId: pack.id, sourceAssetId: source.id, userId: user.id, generationRunId, facecamStatus: schema.FacecamDetectionStatus.READY, facecamDetectionId: detection.id });
      assert.equal(snapshot.facecam.preferredLayout, template.defaultLayout);
      assert.equal(resolved.config.layout, template.defaultLayout);
      assert.equal(resolved.config.layout, schema.RenderedClipLayout.FACECAM_TOP_30);
      assert.equal(resolved.config.layoutRatio, '30_70');
      assert.equal(resolved.config.facecamDetectionId, detection.id);
      assert.equal(resolved.config.facecamDetected, true);
      await db.update(schema.clipCandidateFacecamDetections).set({ detectorVersion: 'other-version' }).where(eq(schema.clipCandidateFacecamDetections.id, detection.id));
      await assert.rejects(resolveCandidateEffectiveRenderConfig({ clipCandidateId: candidate.id, contentPackId: pack.id, sourceAssetId: source.id, userId: user.id, generationRunId, facecamStatus: schema.FacecamDetectionStatus.READY, facecamDetectionId: detection.id }), /facecam_detection_authority_mismatch/);
      await db.update(schema.clipCandidateFacecamDetections).set({ detectorVersion: 'snapshot-detector-v1' }).where(eq(schema.clipCandidateFacecamDetections.id, detection.id));
    });

    await t.test('snapshot generation requeues the persisted run without replacing authority', async () => {
      const before = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.id, generationRunId));
      const job = await enqueueShortFormPackJob(pack.id, source.id, transcript.id, user.id, undefined, db);
      assert.equal((job!.payload as { generationRunId: string }).generationRunId, generationRunId);
      const [after] = await db.select().from(schema.contentPacks).where(eq(schema.contentPacks.id, pack.id));
      assert.equal(after!.generationRunId, generationRunId);
      assert.equal((await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.id, generationRunId))).length, before.length);
    });

    await t.test('missing snapshot generation run never falls back to legacy', async () => {
      const [missing] = await db.insert(schema.contentPacks).values({ userId: user.id, projectId: project.id, sourceAssetId: source.id, transcriptId: transcript.id, kind: schema.ContentPackKind.SHORT_FORM_CLIPS, name: 'Missing run', generationRunId: randomUUID(), shortFormGenerationMode: 'snapshot' }).returning();
      const candidate = (await db.insert(schema.clipCandidates).values({ userId: user.id, contentPackId: missing.id, sourceAssetId: source.id, transcriptId: transcript.id, rank: 1, startTimeMs: 0, endTimeMs: 1_000, durationMs: 1_000, hook: 'Hook', title: 'Missing', captionCopy: 'Caption', summary: 'Summary', transcriptExcerpt: 'Excerpt', whyItWorks: 'Why', platformFit: 'Fit', confidence: 90, generationRunId: missing.generationRunId, facecamDetectionStatus: schema.FacecamDetectionStatus.NOT_FOUND }).returning())[0]!;
      await assert.rejects(resolveCandidateEffectiveRenderConfig({ clipCandidateId: candidate.id, contentPackId: missing.id, sourceAssetId: source.id, userId: user.id, generationRunId: missing.generationRunId, facecamStatus: schema.FacecamDetectionStatus.NOT_FOUND }), /generation_snapshot_missing_requires_regeneration/);
      await db.update(schema.contentPacks).set({ shortFormGenerationMode: 'legacy' }).where(eq(schema.contentPacks.id, missing.id));
    });

    await t.test('two candidates retain exactly two current config, artifact, and work identities', async () => {
      const first = await makeCandidate(10);
      const second = await makeCandidate(11);
      const firstResolved = await resolve(first);
      const secondResolved = await resolve(second);
      await artifactFor(first, firstResolved.config, schema.RenderedClipStatus.READY);
      await artifactFor(second, secondResolved.config, schema.RenderedClipStatus.READY);
      const candidates = await db.select().from(schema.clipCandidates).where(and(eq(schema.clipCandidates.contentPackId, pack.id), eq(schema.clipCandidates.generationRunId, generationRunId)));
      const currentIds = candidates.map((candidate) => candidate.currentRenderConfigId).filter((id): id is number => id !== null);
      const artifacts = await db.select().from(schema.renderedClips).where(eq(schema.renderedClips.contentPackId, pack.id));
      const renderJobs = await db.select().from(schema.jobs).where(eq(schema.jobs.type, schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM));
      assert.equal(currentIds.filter((id) => [firstResolved.config.id, secondResolved.config.id].includes(id)).length, 2);
      assert.equal(artifacts.filter((clip) => [firstResolved.config.id, secondResolved.config.id].includes(clip.clipRenderConfigId ?? -1)).length, 2);
      assert.equal(renderJobs.filter((job) => [firstResolved.job.id, secondResolved.job.id].includes(job.id)).length, 2);
    });

    await t.test('snapshot finalization and reconciliation use current pointers, not history', async () => {
      await db.update(schema.jobs).set({ status: schema.JobStatus.COMPLETED })
        .where(eq(schema.jobs.type, schema.JobType.GENERATE_SHORT_FORM_PACK));
      const readyCandidate = await makeCandidate(20);
      const failedCandidate = await makeCandidate(21);
      const readyConfig = await resolve(readyCandidate);
      const failedConfig = await resolve(failedCandidate);
      await artifactFor(readyCandidate, readyConfig.config, schema.RenderedClipStatus.READY);
      await artifactFor(failedCandidate, failedConfig.config, schema.RenderedClipStatus.FAILED);
      await db.update(schema.jobs).set({ status: schema.JobStatus.COMPLETED, completedAt: new Date() })
        .where(eq(schema.jobs.type, schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM));
      await reconcileShortFormContentPackStatus({ contentPackId: pack.id, sourceAssetId: source.id, generationRunId });
      let [updated] = await db.select().from(schema.contentPacks).where(eq(schema.contentPacks.id, pack.id));
      assert.equal(updated!.status, schema.ContentPackStatus.PARTIALLY_READY);
      await reconcileProjectPipeline(project.id);
      [updated] = await db.select().from(schema.contentPacks).where(eq(schema.contentPacks.id, pack.id));
      assert.equal(updated!.status, schema.ContentPackStatus.PARTIALLY_READY);
    });

    await t.test('snapshot finalization and reconciliation agree across READY, GENERATING, PARTIALLY_READY, and FAILED', async () => {
      const assertState = async (name: string, expected: typeof schema.ContentPackStatus[keyof typeof schema.ContentPackStatus], artifactStatuses: string[], historicalActive = false) => {
        const target = await createSnapshotPack(`Finalization ${name}`);
        for (const [index, status] of artifactStatuses.entries()) {
          const candidate = await makeCandidate(70 + index + Math.floor(Math.random() * 10_000), target);
          const initial = await resolve(candidate);
          if (historicalActive) await artifactFor(candidate, initial.config, schema.RenderedClipStatus.READY);
          let current = initial;
          if (historicalActive) {
            const [run] = await db.insert(schema.clipCandidateFacecamDetectionRuns).values({ userId: user.id, sourceAssetId: source.id, contentPackId: target.pack.id, clipCandidateId: candidate.id, generationRunId: target.generationRunId, detectorVersion: 'snapshot-detector-v1', startTimeMs: candidate.startTimeMs, endTimeMs: candidate.endTimeMs, status: schema.FacecamDetectionStatus.READY }).returning();
            const [detection] = await db.insert(schema.clipCandidateFacecamDetections).values({ userId: user.id, sourceAssetId: source.id, clipCandidateId: candidate.id, detectionRunId: run!.id, generationRunId: target.generationRunId, detectorVersion: 'snapshot-detector-v1', rank: 1, startTimeMs: candidate.startTimeMs, endTimeMs: candidate.endTimeMs, frameWidth: 100, frameHeight: 100, xPx: 0, yPx: 0, widthPx: 20, heightPx: 20, confidence: 99, sampledFrameCount: 1 }).returning();
            await db.update(schema.clipCandidates).set({ facecamDetectionStatus: schema.FacecamDetectionStatus.READY }).where(eq(schema.clipCandidates.id, candidate.id));
            current = await resolveCandidateEffectiveRenderConfig({ clipCandidateId: candidate.id, contentPackId: target.pack.id, sourceAssetId: source.id, userId: user.id, generationRunId: target.generationRunId, facecamStatus: schema.FacecamDetectionStatus.READY, facecamDetectionId: detection!.id });
          }
          await artifactFor(candidate, current.config, status);
          if (status !== schema.RenderedClipStatus.PENDING) await db.update(schema.jobs).set({ status: schema.JobStatus.COMPLETED, completedAt: new Date() }).where(eq(schema.jobs.id, current.job.id));
          if (!historicalActive) await db.update(schema.jobs).set({ status: schema.JobStatus.COMPLETED, completedAt: new Date() }).where(eq(schema.jobs.id, initial.job.id));
        }
        await reconcileShortFormContentPackStatus({ contentPackId: target.pack.id, sourceAssetId: source.id, generationRunId: target.generationRunId });
        let [after] = await db.select().from(schema.contentPacks).where(eq(schema.contentPacks.id, target.pack.id));
        assert.equal(after!.status, expected, `${name} normal finalizer`);
        await reconcileProjectPipeline(project.id);
        [after] = await db.select().from(schema.contentPacks).where(eq(schema.contentPacks.id, target.pack.id));
        assert.equal(after!.status, expected, `${name} reconciliation`);
      };

      await assertState('READY', schema.ContentPackStatus.READY, [schema.RenderedClipStatus.READY]);
      await assertState('GENERATING', schema.ContentPackStatus.GENERATING, [schema.RenderedClipStatus.PENDING], true);
      await assertState('PARTIALLY_READY', schema.ContentPackStatus.PARTIALLY_READY, [schema.RenderedClipStatus.READY, schema.RenderedClipStatus.FAILED]);
      await assertState('FAILED', schema.ContentPackStatus.FAILED, [schema.RenderedClipStatus.FAILED, schema.RenderedClipStatus.FAILED]);
    });

    await t.test('superseded historical artifacts cannot authorize publication or current work', async () => {
      const candidate = await makeCandidate(30);
      const a = await resolve(candidate);
      const historical = await artifactFor(candidate, a.config, schema.RenderedClipStatus.READY);
      const [b] = await db.insert(schema.clipRenderConfigs).values({
        userId: user.id, contentPackId: pack.id, sourceAssetId: source.id, clipCandidateId: candidate.id,
        generationRunId, aspectRatio: a.config.aspectRatio, layout: a.config.layout, layoutRatio: a.config.layoutRatio,
        captionsEnabled: a.config.captionsEnabled, captionStyle: a.config.captionStyle, captionFontAssetId: a.config.captionFontAssetId,
        captionFontFamily: a.config.captionFontFamily, captionFontColor: a.config.captionFontColor, captionHighlightColor: a.config.captionHighlightColor,
        captionPosition: a.config.captionPosition, captionAnimation: a.config.captionAnimation, brandTemplateId: a.config.brandTemplateId,
        overlayLogoAssetId: a.config.overlayLogoAssetId, ctaUrl: a.config.ctaUrl, introVideoAssetId: a.config.introVideoAssetId,
        outroVideoAssetId: a.config.outroVideoAssetId, cropSettings: a.config.cropSettings, facecamDetectionId: a.config.facecamDetectionId,
        facecamDetected: a.config.facecamDetected, autoEditPreset: a.config.autoEditPreset, configHash: `${a.config.configHash}-successor`,
      }).returning();
      await db.update(schema.clipCandidates).set({ currentRenderConfigId: b.id }).where(eq(schema.clipCandidates.id, candidate.id));
      const current = await artifactFor(candidate, b, schema.RenderedClipStatus.READY);
      await assert.rejects(assertRenderedClipPublicationAuthority({ renderedClipId: historical.id, userId: user.id }), /not the current snapshot output/);
      assert.equal((await assertRenderedClipPublicationAuthority({ renderedClipId: current.id, userId: user.id })).id, current.id);
      const [persisted] = await db.select().from(schema.clipCandidates).where(eq(schema.clipCandidates.id, candidate.id));
      assert.equal(persisted!.currentRenderConfigId, b.id);
    });

    await t.test('legacy historical READY artifacts remain publishable after generation rotation', async () => {
      const historicalGenerationRunId = randomUUID();
      const currentGenerationRunId = randomUUID();
      const [legacyPack] = await db.insert(schema.contentPacks).values({
        userId: user.id,
        projectId: project.id,
        sourceAssetId: source.id,
        transcriptId: transcript.id,
        kind: schema.ContentPackKind.SHORT_FORM_CLIPS,
        name: 'Legacy rotated pack',
        generationRunId: currentGenerationRunId,
        shortFormGenerationMode: 'legacy',
      }).returning();
      const candidate = await makeCandidate(31, { pack: legacyPack!, generationRunId: historicalGenerationRunId });
      const [artifact] = await db.insert(schema.renderedClips).values({
        userId: user.id,
        contentPackId: legacyPack!.id,
        sourceAssetId: source.id,
        clipCandidateId: candidate.id,
        generationRunId: historicalGenerationRunId,
        variant: schema.RenderedClipVariant.VERTICAL_SHORT_FORM,
        layout: schema.RenderedClipLayout.DEFAULT,
        status: schema.RenderedClipStatus.READY,
        title: candidate.title,
        startTimeMs: candidate.startTimeMs,
        endTimeMs: candidate.endTimeMs,
        durationMs: candidate.durationMs,
        storageKey: `legacy/${randomUUID()}.mp4`,
        storageUrl: 'storage://legacy-ready',
        mimeType: 'video/mp4',
      }).returning();
      assert.equal((await assertRenderedClipPublicationAuthority({ renderedClipId: artifact!.id, userId: user.id })).id, artifact!.id);
    });

    await t.test('snapshot reconciliation with no candidates fails closed without legacy rebuild', async () => {
      const emptyRun = randomUUID();
      const [emptyPack] = await db.insert(schema.contentPacks).values({ userId: user.id, projectId: project.id, sourceAssetId: source.id, transcriptId: transcript.id, kind: schema.ContentPackKind.SHORT_FORM_CLIPS, name: 'Empty snapshot', generationRunId: emptyRun, shortFormGenerationMode: 'snapshot' }).returning();
      await insertGenerationRun({ generationRunId: emptyRun, contentPackId: emptyPack.id, selectedBrandTemplateId: template.id, snapshot }, db);
      await reconcileProjectPipeline(project.id);
      const [after] = await db.select().from(schema.contentPacks).where(eq(schema.contentPacks.id, emptyPack.id));
      const generationJobs = await db.select().from(schema.jobs).where(eq(schema.jobs.type, schema.JobType.GENERATE_SHORT_FORM_PACK));
      assert.equal(after!.generationRunId, emptyRun);
      assert.equal(after!.status, schema.ContentPackStatus.FAILED);
      assert.equal(generationJobs.some((job) => (job.payload as { contentPackId?: number }).contentPackId === emptyPack.id), false);
    });

    await t.test('recovery reuses an active exact successor and does not increase its recovery count', async () => {
      const candidate = await makeCandidate(40);
      const resolved = await resolve(candidate);
      await artifactFor(candidate, resolved.config, schema.RenderedClipStatus.FAILED);
      await db.update(schema.jobs).set({ status: schema.JobStatus.FAILED, failureClass: schema.JobFailureClass.SAFE_NO_EXTERNAL_EFFECT, recoveryAttempt: 0 })
        .where(eq(schema.jobs.id, resolved.job.id));
      const first = await resolve(candidate);
      const second = await resolve(candidate);
      const jobs = await exactRenderJobs(candidate.id, resolved.config.id);
      assert.equal(first.job.id, second.job.id);
      assert.equal(jobs.filter((job) => job.status === schema.JobStatus.PENDING || job.status === schema.JobStatus.PROCESSING).length, 1);
      assert.equal(jobs.filter((job) => job.recoveryAttempt === 1).length, 1);
    });

    await t.test('safe retryable terminal failure creates one exact successor', async () => {
      const candidate = await makeCandidate(41);
      const resolved = await resolve(candidate);
      await artifactFor(candidate, resolved.config, schema.RenderedClipStatus.FAILED);
      await db.update(schema.jobs).set({ status: schema.JobStatus.FAILED, failureClass: schema.JobFailureClass.SAFE_NO_EXTERNAL_EFFECT, recoveryAttempt: 0, maxAttempts: 2 })
        .where(eq(schema.jobs.id, resolved.job.id));
      const successor = await resolve(candidate);
      await resolve(candidate);
      const jobs = await exactRenderJobs(candidate.id, resolved.config.id);
      assert.equal((successor.job.payload as { renderConfigId: number }).renderConfigId, resolved.config.id);
      assert.equal(jobs.length, 2);
      assert.equal(jobs.filter((job) => job.status === schema.JobStatus.PENDING).length, 1);
    });

    await t.test('non-retryable terminal failure is accounted', async () => {
      const candidate = await makeCandidate(42);
      const resolved = await resolve(candidate);
      await artifactFor(candidate, resolved.config, schema.RenderedClipStatus.FAILED);
      await db.update(schema.jobs).set({ status: schema.JobStatus.FAILED, failureClass: schema.JobFailureClass.PERMANENT, recoveryAttempt: 0, maxAttempts: 3 }).where(eq(schema.jobs.id, resolved.job.id));
      await resolve(candidate);
      const jobs = await exactRenderJobs(candidate.id, resolved.config.id);
      assert.equal(jobs.length, 1);
    });

    await t.test('exhausted recovery budget terminalizes idempotently without a successor', async () => {
      const target = await createSnapshotPack('Exhausted recovery');
      const candidate = await makeCandidate(43, target);
      const resolved = await resolve(candidate);
      await db.update(schema.jobs).set({ status: schema.JobStatus.FAILED, failureClass: schema.JobFailureClass.SAFE_NO_EXTERNAL_EFFECT, recoveryAttempt: 3, maxAttempts: 3 }).where(eq(schema.jobs.id, resolved.job.id));
      await resolve(candidate);
      await reconcileShortFormContentPackStatus({ contentPackId: target.pack.id, sourceAssetId: source.id, generationRunId: target.generationRunId });
      await reconcileShortFormContentPackStatus({ contentPackId: target.pack.id, sourceAssetId: source.id, generationRunId: target.generationRunId });
      const jobs = await exactRenderJobs(candidate.id, resolved.config.id);
      const artifacts = await db.select().from(schema.renderedClips).where(and(eq(schema.renderedClips.clipCandidateId, candidate.id), eq(schema.renderedClips.clipRenderConfigId, resolved.config.id)));
      const [persisted] = await db.select().from(schema.contentPacks).where(eq(schema.contentPacks.id, target.pack.id));
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0]!.status, schema.JobStatus.FAILED);
      assert.equal(artifacts.length, 0);
      assert.equal(persisted!.status, schema.ContentPackStatus.FAILED);
    });

    await t.test('v2 provider results persist independent candidate outcomes and exact render authority', async () => {
      const runId = randomUUID();
      const [v2Pack] = await db.insert(schema.contentPacks).values({ userId: user.id, projectId: project.id, sourceAssetId: source.id, transcriptId: transcript.id, kind: schema.ContentPackKind.SHORT_FORM_CLIPS, name: 'V2 detection', generationRunId: runId, shortFormGenerationMode: 'snapshot' }).returning();
      await insertGenerationRun({ generationRunId: runId, contentPackId: v2Pack!.id, selectedBrandTemplateId: template.id, snapshot: { ...snapshot, facecam: { ...snapshot.facecam, detectorVersion: 'facecam_v2' } } }, db);
      await db.update(schema.sourceAssets).set({ originalFilename: 'fixture.mp4' }).where(eq(schema.sourceAssets.id, source.id));
      for (const [rank, hasFacecam] of [[48, true], [49, false]] as const) {
        const candidate = await makeCandidate(rank, { pack: v2Pack!, generationRunId: runId });
        await enqueueDetectCandidateFacecamJob(candidate, 'facecam_v2');
        const [run] = await db.select().from(schema.clipCandidateFacecamDetectionRuns).where(eq(schema.clipCandidateFacecamDetectionRuns.clipCandidateId, candidate.id));
        assert.ok(run?.jobId);
        const leaseToken = randomUUID();
        await db.update(schema.jobs).set({ status: schema.JobStatus.PROCESSING, leaseToken, leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(schema.jobs.id, run.jobId));
        const result = await detectCandidateFacecam({ detectionRunId: run.id, clipCandidateId: candidate.id, contentPackId: v2Pack!.id, sourceAssetId: source.id, userId: user.id, generationRunId: runId, startTimeMs: candidate.startTimeMs, endTimeMs: candidate.endTimeMs, detectorVersion: 'facecam_v2', authority: { jobId: run.jobId, leaseToken } }, {
          createDownload: () => ({ method: 'GET', downloadUrl: 'https://storage.invalid/fixture.mp4' }),
          detectRegions: async (input) => {
            assert.equal(input.detectorVersion, 'facecam_v2');
            assert.equal(input.startTimeMs, candidate.startTimeMs);
            assert.equal(input.endTimeMs, candidate.endTimeMs);
            return { frameWidth: 1920, frameHeight: 1080, sampledFrameCount: 10, candidates: hasFacecam ? [{ rank: 1, xPx: 0, yPx: 0, widthPx: 400, heightPx: 300, confidence: 35 }] : [] };
          },
        });
        assert.equal(result.status, hasFacecam ? schema.FacecamDetectionStatus.READY : schema.FacecamDetectionStatus.NOT_FOUND);
        const projection = await db.transaction(async (tx) => await replayCandidateFacecamTerminalProjection({ candidate, detectionRunIdentity: run.id, status: result.status, executor: tx }));
        const config = snapshotRenderConfig(projection);
        assert.equal(config.facecamDetected, hasFacecam);
        assert.equal(config.layout, hasFacecam ? snapshot.facecam.preferredLayout : snapshot.facecam.fallbackLayout);
        const [persisted] = await db.select().from(schema.clipCandidates).where(eq(schema.clipCandidates.id, candidate.id));
        assert.equal(persisted!.currentRenderConfigId, config.id);
        assert.equal((await db.select().from(schema.clipRenderConfigs).where(eq(schema.clipRenderConfigs.clipCandidateId, candidate.id))).length, 1);
        if (hasFacecam) {
          const detection = await getFacecamDetectionForRender({ facecamDetectionId: config.facecamDetectionId, sourceAssetId: source.id, userId: user.id, clipCandidateId: candidate.id, generationRunId: runId, startTimeMs: candidate.startTimeMs, endTimeMs: candidate.endTimeMs, detectorVersion: 'facecam_v2' });
          assert.equal(detection?.id, config.facecamDetectionId);
          const artifact = await db.transaction(async (tx) => await ensureRenderedClipPending({ clipCandidateId: candidate.id, userId: user.id, variant: schema.RenderedClipVariant.VERTICAL_SHORT_FORM, layout: config.layout as typeof schema.RenderedClipLayout[keyof typeof schema.RenderedClipLayout], renderConfig: config }, tx));
          assert.equal(artifact.clipRenderConfigId, config.id);
          assert.equal(artifact.status, schema.RenderedClipStatus.PENDING);
          await assert.rejects(db.transaction(async (tx) => await ensureRenderedClipPending({ clipCandidateId: candidate.id, userId: user.id, variant: schema.RenderedClipVariant.VERTICAL_SHORT_FORM, layout: config.layout as typeof schema.RenderedClipLayout[keyof typeof schema.RenderedClipLayout], renderConfig: { ...config, facecamDetectionId: null } }, tx)), /ready facecam detection/);
          const [persistedDetection] = await db.select().from(schema.clipCandidateFacecamDetections).where(eq(schema.clipCandidateFacecamDetections.id, config.facecamDetectionId!));
          await db.update(schema.clipCandidateFacecamDetections).set({ startTimeMs: candidate.startTimeMs + 1 }).where(eq(schema.clipCandidateFacecamDetections.id, persistedDetection!.id));
          await assert.rejects(db.transaction(async (tx) => await ensureRenderedClipPending({ clipCandidateId: candidate.id, userId: user.id, variant: schema.RenderedClipVariant.VERTICAL_SHORT_FORM, layout: config.layout as typeof schema.RenderedClipLayout[keyof typeof schema.RenderedClipLayout], renderConfig: config }, tx)), /ready facecam detection/);
          await db.update(schema.clipCandidateFacecamDetections).set({ startTimeMs: candidate.startTimeMs }).where(eq(schema.clipCandidateFacecamDetections.id, persistedDetection!.id));
        } else {
          assert.equal(config.facecamDetectionId, null);
        }
      }
    });

    await t.test('exhausted preparation failure terminalizes without an artifact and reconciles the pack', async () => {
      const target = await createSnapshotPack('Preparation failures');
      const candidates = [await makeCandidate(90, target), await makeCandidate(91, target)];
      const configs = [];
      const renderJobs = [];
      for (const candidate of candidates) {
        await db.update(schema.clipCandidates).set({ facecamDetectionStatus: schema.FacecamDetectionStatus.NOT_FOUND }).where(eq(schema.clipCandidates.id, candidate.id));
        const resolved = await resolve(candidate);
        configs.push(resolved.config);
        renderJobs.push(resolved.job);
      }
      const runtime = {
        ...productionPipelineProcessingRuntime,
        processors: { ...productionPipelineProcessingRuntime.processors, formatClip: async () => { throw new Error('Preparation failed before any artifact was created'); } },
        downstream: { trigger: () => undefined },
      };
      for (const [index, renderJob] of renderJobs.entries()) {
        const leaseToken = randomUUID();
        const [claimed] = await db.update(schema.jobs).set({ status: schema.JobStatus.PROCESSING, attemptCount: 3, leaseToken, leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(schema.jobs.id, renderJob.id)).returning();
        const result = await processClaimedJob(claimed! as Parameters<typeof processClaimedJob>[0], runtime);
        assert.equal(result.status, 'failed');
        const [persistedJob] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, renderJob.id));
        assert.equal(persistedJob!.status, schema.JobStatus.FAILED);
        assert.equal(persistedJob!.failureClass, schema.JobFailureClass.SAFE_NO_EXTERNAL_EFFECT);
        assert.equal(persistedJob!.leaseToken, null);
        assert.equal(persistedJob!.leaseExpiresAt, null);
        assert.equal((await db.select().from(schema.renderedClips).where(eq(schema.renderedClips.clipCandidateId, candidates[index]!.id))).length, 0);
        const [persistedPack] = await db.select().from(schema.contentPacks).where(eq(schema.contentPacks.id, target.pack.id));
        assert.equal(persistedPack!.status, index === 0 ? schema.ContentPackStatus.GENERATING : schema.ContentPackStatus.FAILED);
      }
      await assert.rejects(markRenderedClipFailed(candidates[0]!.id, user.id, schema.RenderedClipVariant.VERTICAL_SHORT_FORM, 'invalid identity', schema.RenderedClipLayout.DEFAULT, db, { renderConfigId: configs[1]!.id, generationRunId: target.generationRunId }), /snapshot_render_failure_identity_mismatch/);
    });

    await t.test('facecam fallback uses one current config for NOT_FOUND and terminal failure', async () => {
      for (const [rank, status] of [[50, schema.FacecamDetectionStatus.NOT_FOUND], [51, schema.FacecamDetectionStatus.FAILED_NETWORK]] as const) {
        const candidate = await makeCandidate(rank);
        await db.update(schema.clipCandidates).set({ facecamDetectionStatus: status }).where(eq(schema.clipCandidates.id, candidate.id));
        const resolved = await resolve(candidate);
        const configs = await db.select().from(schema.clipRenderConfigs).where(eq(schema.clipRenderConfigs.clipCandidateId, candidate.id));
        assert.equal(resolved.config.layout, schema.RenderedClipLayout.DEFAULT);
        assert.equal(resolved.config.facecamDetected, false);
        assert.equal(configs.length, 1);
      }
    });

    await t.test('terminal facecam replay derives snapshot authority from the persisted detector run', async () => {
      const replay = async (candidate: Awaited<ReturnType<typeof makeCandidate>>, detectionRunId: number, status: typeof schema.FacecamDetectionStatus[keyof typeof schema.FacecamDetectionStatus]) =>
        await db.transaction(async (tx) => await replayCandidateFacecamTerminalProjection({
          candidate,
          detectionRunIdentity: detectionRunId,
          status,
          failureReason: 'caller failure must not win',
          debugReason: 'caller debug must not win',
          executor: tx,
        }));
      const insertRun = async (candidate: Awaited<ReturnType<typeof makeCandidate>>, status: string, values: Record<string, unknown> = {}) =>
        (await db.insert(schema.clipCandidateFacecamDetectionRuns).values({
          userId: user.id,
          sourceAssetId: source.id,
          contentPackId: candidate.contentPackId,
          clipCandidateId: candidate.id,
          generationRunId: candidate.generationRunId,
          detectorVersion: 'snapshot-detector-v1',
          startTimeMs: candidate.startTimeMs,
          endTimeMs: candidate.endTimeMs,
          status,
          completedAt: new Date(),
          ...values,
        }).returning())[0]!;
      const readyCandidate = await makeCandidate(55);
      const readyRun = await insertRun(readyCandidate, schema.FacecamDetectionStatus.READY);
      await db.insert(schema.clipCandidateFacecamDetections).values({ userId: user.id, sourceAssetId: source.id, clipCandidateId: readyCandidate.id, detectionRunId: readyRun.id, generationRunId, detectorVersion: 'snapshot-detector-v1', rank: 1, startTimeMs: readyCandidate.startTimeMs, endTimeMs: readyCandidate.endTimeMs, frameWidth: 100, frameHeight: 100, xPx: 0, yPx: 0, widthPx: 20, heightPx: 20, confidence: 99, sampledFrameCount: 1 });
      const ready = await replay(readyCandidate, readyRun.id, schema.FacecamDetectionStatus.READY);
      assert.equal(snapshotRenderConfig(ready).layout, schema.RenderedClipLayout.FACECAM_TOP_30);

      const notFoundCandidate = await makeCandidate(56);
      const notFoundRun = await insertRun(notFoundCandidate, schema.FacecamDetectionStatus.NOT_FOUND);
      const notFound = await replay(notFoundCandidate, notFoundRun.id, schema.FacecamDetectionStatus.READY);
      const [persistedNotFound] = await db.select().from(schema.clipCandidates).where(eq(schema.clipCandidates.id, notFoundCandidate.id));
      assert.equal(persistedNotFound!.facecamDetectionStatus, schema.FacecamDetectionStatus.NOT_FOUND);
      assert.equal(snapshotRenderConfig(notFound).layout, schema.RenderedClipLayout.DEFAULT);

      const failedCandidate = await makeCandidate(57);
      const failedRun = await insertRun(failedCandidate, schema.FacecamDetectionStatus.FAILED_NETWORK, { failureReason: 'persisted detector failure', debugReason: 'persisted diagnostic' });
      const failed = await replay(failedCandidate, failedRun.id, schema.FacecamDetectionStatus.READY);
      const [persistedFailed] = await db.select().from(schema.clipCandidates).where(eq(schema.clipCandidates.id, failedCandidate.id));
      assert.equal(snapshotRenderConfig(failed).layout, schema.RenderedClipLayout.DEFAULT);
      assert.equal(persistedFailed!.facecamDetectionFailureReason, 'persisted detector failure');
      assert.equal(persistedFailed!.facecamDetectionDebugReason, 'persisted diagnostic');
    });

    await t.test('facecam detection disabled ignores stale READY detection', async () => {
      const disabledRun = randomUUID();
      const disabledSnapshot = { ...snapshot, facecam: { ...snapshot.facecam, detectionEnabled: false } };
      const [disabledPack] = await db.insert(schema.contentPacks).values({ userId: user.id, projectId: project.id, sourceAssetId: source.id, transcriptId: transcript.id, kind: schema.ContentPackKind.SHORT_FORM_CLIPS, name: 'Disabled facecam', generationRunId: disabledRun, shortFormGenerationMode: 'snapshot' }).returning();
      await insertGenerationRun({ generationRunId: disabledRun, contentPackId: disabledPack!.id, selectedBrandTemplateId: template.id, snapshot: disabledSnapshot }, db);
      const candidate = await makeCandidate(54, { pack: disabledPack!, generationRunId: disabledRun });
      await db.update(schema.clipCandidates).set({ facecamDetectionStatus: schema.FacecamDetectionStatus.READY }).where(eq(schema.clipCandidates.id, candidate.id));
      const resolved = await resolveCandidateEffectiveRenderConfig({ clipCandidateId: candidate.id, contentPackId: disabledPack!.id, sourceAssetId: source.id, userId: user.id, generationRunId: disabledRun, facecamStatus: schema.FacecamDetectionStatus.READY });
      assert.equal(resolved.config.layout, schema.RenderedClipLayout.DEFAULT);
      assert.equal(resolved.config.facecamDetected, false);
      assert.equal(resolved.config.facecamDetectionId, null);

      const [disabledDetectionRun] = await db.insert(schema.clipCandidateFacecamDetectionRuns).values({ userId: user.id, sourceAssetId: source.id, contentPackId: disabledPack!.id, clipCandidateId: candidate.id, generationRunId: disabledRun, detectorVersion: 'snapshot-detector-v1', startTimeMs: candidate.startTimeMs, endTimeMs: candidate.endTimeMs, status: schema.FacecamDetectionStatus.READY, completedAt: new Date() }).returning();
      await db.insert(schema.clipCandidateFacecamDetections).values({ userId: user.id, sourceAssetId: source.id, clipCandidateId: candidate.id, detectionRunId: disabledDetectionRun!.id, generationRunId: disabledRun, detectorVersion: 'snapshot-detector-v1', rank: 1, startTimeMs: candidate.startTimeMs, endTimeMs: candidate.endTimeMs, frameWidth: 100, frameHeight: 100, xPx: 0, yPx: 0, widthPx: 20, heightPx: 20, confidence: 99, sampledFrameCount: 1 });
      const replayed = await db.transaction(async (tx) => await replayCandidateFacecamTerminalProjection({ candidate, detectionRunIdentity: disabledDetectionRun!.id, status: schema.FacecamDetectionStatus.READY, executor: tx }));
      const [persisted] = await db.select().from(schema.clipCandidates).where(eq(schema.clipCandidates.id, candidate.id));
      assert.equal(persisted!.facecamDetectionStatus, schema.FacecamDetectionStatus.NOT_FOUND);
      assert.equal(snapshotRenderConfig(replayed).layout, schema.RenderedClipLayout.DEFAULT);
    });

    await t.test('facecam authority rejects wrong candidate, generation, source, and timing', async () => {
      const candidate = await makeCandidate(52);
      const other = await makeCandidate(53);
      await db.update(schema.clipCandidates).set({ facecamDetectionStatus: schema.FacecamDetectionStatus.READY }).where(eq(schema.clipCandidates.id, candidate.id));
      const [run] = await db.insert(schema.clipCandidateFacecamDetectionRuns).values({ userId: user.id, sourceAssetId: source.id, contentPackId: pack.id, clipCandidateId: candidate.id, generationRunId, detectorVersion: 'snapshot-detector-v1', startTimeMs: candidate.startTimeMs, endTimeMs: candidate.endTimeMs, status: schema.FacecamDetectionStatus.READY }).returning();
      const [otherSource] = await db.insert(schema.sourceAssets).values({ userId: user.id, projectId: project.id, title: 'Other source', assetType: schema.SourceAssetType.UPLOADED_FILE, mimeType: 'video/mp4', storageKey: `snapshot-life/${randomUUID()}.mp4`, storageUrl: 'storage://other-source', status: schema.SourceAssetStatus.READY }).returning();
      const insertDetection = (values: Record<string, unknown>) => db.insert(schema.clipCandidateFacecamDetections).values({ userId: user.id, sourceAssetId: source.id, clipCandidateId: candidate.id, detectionRunId: run.id, generationRunId, detectorVersion: 'snapshot-detector-v1', rank: 1, startTimeMs: candidate.startTimeMs, endTimeMs: candidate.endTimeMs, frameWidth: 100, frameHeight: 100, xPx: 0, yPx: 0, widthPx: 20, heightPx: 20, confidence: 99, sampledFrameCount: 1, ...values }).returning();
      const [wrongCandidate] = await insertDetection({ clipCandidateId: other.id, rank: 2 });
      const [wrongGeneration] = await insertDetection({ generationRunId: randomUUID(), rank: 3 });
      const [wrongSource] = await insertDetection({ sourceAssetId: otherSource.id, rank: 4 });
      const [wrongTiming] = await insertDetection({ startTimeMs: candidate.startTimeMs + 1, rank: 5 });
      for (const detection of [wrongCandidate, wrongGeneration, wrongSource, wrongTiming]) {
        await assert.rejects(resolveCandidateEffectiveRenderConfig({ clipCandidateId: candidate.id, contentPackId: pack.id, sourceAssetId: source.id, userId: user.id, generationRunId, facecamStatus: schema.FacecamDetectionStatus.READY, facecamDetectionId: detection!.id }), /facecam_detection_authority_mismatch/);
      }
    });

    await t.test('stale render job cannot publish READY after its current pointer changes', async () => {
      const candidate = await makeCandidate(60);
      const a = await resolve(candidate);
      const artifactA = await artifactFor(candidate, a.config, schema.RenderedClipStatus.RENDERING);
      const { id: _aId, createdAt: _aCreatedAt, updatedAt: _aUpdatedAt, ...aValues } = a.config;
      const [b] = await db.insert(schema.clipRenderConfigs).values({ ...aValues, configHash: `${a.config.configHash}-b` }).returning();
      await db.update(schema.clipCandidates).set({ currentRenderConfigId: b.id }).where(eq(schema.clipCandidates.id, candidate.id));
      const token = randomUUID();
      await db.update(schema.jobs).set({ status: schema.JobStatus.PROCESSING, leaseToken: token, leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(schema.jobs.id, a.job.id));
      await assert.rejects(withAuthorizedJobSuccessTransaction({ jobId: a.job.id, leaseToken: token }, async (tx) => {
        await tx.update(schema.renderedClips).set({ status: schema.RenderedClipStatus.READY }).where(eq(schema.renderedClips.id, artifactA.id));
      }), /render_config_superseded/);
      const [after] = await db.select().from(schema.renderedClips).where(eq(schema.renderedClips.id, artifactA.id));
      const [persisted] = await db.select().from(schema.clipCandidates).where(eq(schema.clipCandidates.id, candidate.id));
      assert.equal(after!.status, schema.RenderedClipStatus.RENDERING);
      assert.equal(persisted!.currentRenderConfigId, b.id);
    });

    await t.test('failure handling uses exact historical render-config identity', async () => {
      const candidate = await makeCandidate(61);
      const a = await resolve(candidate);
      const historical = await artifactFor(candidate, a.config, schema.RenderedClipStatus.RENDERING);
      const { id: _historicalId, createdAt: _historicalCreatedAt, updatedAt: _historicalUpdatedAt, ...historicalValues } = a.config;
      const [b] = await db.insert(schema.clipRenderConfigs).values({ ...historicalValues, configHash: `${a.config.configHash}-current` }).returning();
      const current = await artifactFor(candidate, b, schema.RenderedClipStatus.RENDERING);
      await db.update(schema.clipCandidates).set({ currentRenderConfigId: b.id }).where(eq(schema.clipCandidates.id, candidate.id));
      const { markRenderedClipFailed } = await import('./rendered-clip-service.ts');
      const workerPayload = {
        clipCandidateId: candidate.id,
        userId: user.id,
        generationRunId,
        renderConfigId: a.config.id,
        variant: schema.RenderedClipVariant.VERTICAL_SHORT_FORM,
        layout: a.config.layout as never,
      };
      await markRenderedClipFailed(workerPayload.clipCandidateId, workerPayload.userId, workerPayload.variant, 'historical failure', workerPayload.layout, db, { renderConfigId: workerPayload.renderConfigId, generationRunId: workerPayload.generationRunId });
      const all = await db.select().from(schema.renderedClips).where(eq(schema.renderedClips.clipCandidateId, candidate.id));
      assert.equal(all.find((clip) => clip.id === historical.id)!.status, schema.RenderedClipStatus.FAILED);
      assert.equal(all.find((clip) => clip.id === current.id)!.status, schema.RenderedClipStatus.RENDERING);
      await assert.rejects(markRenderedClipFailed(candidate.id, user.id, schema.RenderedClipVariant.VERTICAL_SHORT_FORM, 'missing identity', a.config.layout as never, db, { generationRunId }), /snapshot_render_failure_identity_required/);
      const afterMalformed = await db.select().from(schema.renderedClips).where(eq(schema.renderedClips.id, current.id));
      assert.equal(afterMalformed[0]!.status, schema.RenderedClipStatus.RENDERING);
    });
  } finally {
    if (appClient) await appClient.end();
    await admin.unsafe(`drop schema if exists "${schemaName}" cascade`);
    await admin.end();
  }
});
