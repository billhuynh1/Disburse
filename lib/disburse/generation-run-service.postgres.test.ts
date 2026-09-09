import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { register } from 'node:module';
import test from 'node:test';

import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { assertDisposablePostgresTestDatabase } from '../db/test-database-guard.ts';

register('../test/typescript-path-loader.mjs', import.meta.url);

test('generation runs persist immutable snapshots without legacy coupling', {
  skip: !process.env.PHASE1A_TEST_DATABASE_URL,
}, async () => {
  const configuredUrl = process.env.PHASE1A_TEST_DATABASE_URL!;
  assertDisposablePostgresTestDatabase(configuredUrl);

  const schemaName = `generation_runs_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(configuredUrl, { max: 1 });
  let appClient: { end(): Promise<void> } | undefined;

  try {
    await admin.unsafe(`create schema "${schemaName}"`);
    await admin.unsafe(`set search_path to "${schemaName}"`);
    const migrationDirectory = new URL('../db/migrations/', import.meta.url);
    const migrations = (await readdir(migrationDirectory))
      .filter((file) => /^\d+.*\.sql$/.test(file))
      .sort();
    for (const migration of migrations) {
      const sql = await readFile(new URL(migration, migrationDirectory), 'utf8');
      for (const statement of sql.split('--> statement-breakpoint')) {
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
    const {
      GenerationRunNotFoundError,
      GenerationRunSnapshotTemplateMismatchError,
      insertGenerationRun,
      loadGenerationRun,
      loadGenerationSnapshot,
    } = await import('./generation-run-service.ts');
    const { InvalidGenerationSnapshotError, materializeGenerationSnapshot } =
      await import('./generation-snapshot.ts');
    const { classifyShortFormGenerationMode } = await import('./short-form-generation-mode-service.ts');
    const { enqueueShortFormPackJob } = await import('./job-service.ts');
    const { activateSnapshotShortFormGeneration } = await import('./snapshot-generation-activation-service.ts');

    const [user] = await db.insert(schema.users).values({
      name: 'Snapshot user',
      email: `snapshot-${randomUUID()}@example.test`,
      passwordHash: 'test',
    }).returning();
    const [project] = await db.insert(schema.projects).values({
      userId: user.id,
      name: 'Snapshot project',
      isSaved: true,
    }).returning();
    const [source] = await db.insert(schema.sourceAssets).values({
      userId: user.id,
      projectId: project.id,
      title: 'Snapshot source',
      assetType: schema.SourceAssetType.UPLOADED_FILE,
      mimeType: 'video/mp4',
      storageKey: `snapshot/${randomUUID()}.mp4`,
      storageUrl: 'storage://snapshot/source.mp4',
      status: schema.SourceAssetStatus.READY,
    }).returning();
    const [transcript] = await db.insert(schema.transcripts).values({
      userId: user.id,
      sourceAssetId: source.id,
      content: 'Grounded transcript',
      status: schema.TranscriptStatus.READY,
    }).returning();
    const [contentPack] = await db.insert(schema.contentPacks).values({
      userId: user.id,
      projectId: project.id,
      sourceAssetId: source.id,
      transcriptId: transcript.id,
      kind: schema.ContentPackKind.SHORT_FORM_CLIPS,
      name: 'Snapshot pack',
      generationRunId: randomUUID(),
    }).returning();
    const [template] = await db.insert(schema.brandTemplates).values({
      userId: user.id,
      name: 'Snapshot template',
    }).returning();

    const snapshot = materializeGenerationSnapshot({
      brandTemplateId: template.id,
      ranking: {
        generationInstructions: 'Find decisive moments.',
        clipLength: '30-60s',
        autoHookEnabled: true,
        contentPackage: 'clips_only',
      },
      facecam: {
        detectionEnabled: true,
        detectorVersion: 'facecam_v1',
        preferredLayout: schema.RenderedClipLayout.FACECAM_TOP_40,
        fallbackLayout: schema.RenderedClipLayout.DEFAULT,
      },
      render: {
        aspectRatio: '9_16', captionsEnabled: true, captionStyle: 'default',
        captionFontAssetId: null, captionFontFamily: null, captionFontColor: '#ffffff',
        captionHighlightColor: '#facc15', captionPosition: 'bottom', captionAnimation: 'none',
        overlayLogoAssetId: null, introVideoAssetId: null, outroVideoAssetId: null,
        ctaUrl: null, cropSettings: { sourceCrop: 'original' },
        autoEditPreset: 'default_short_form_v1',
      },
    });
    const generationRunId = randomUUID();
    await insertGenerationRun({
      generationRunId,
      contentPackId: contentPack.id,
      selectedBrandTemplateId: template.id,
      snapshot,
    }, db);

    await db.update(schema.contentPacks).set({ generationRunId })
      .where(eq(schema.contentPacks.id, contentPack.id));

    assert.deepEqual(
      await classifyShortFormGenerationMode({ generationRunId, contentPackId: contentPack.id }, db),
      { kind: 'legacy' }
    );

    await db.update(schema.contentPacks).set({ shortFormGenerationMode: 'snapshot' })
      .where(eq(schema.contentPacks.id, contentPack.id));
    assert.deepEqual(
      await classifyShortFormGenerationMode({ generationRunId, contentPackId: contentPack.id }, db),
      { kind: 'snapshot', snapshot }
    );
    const queuedSnapshotJob = await enqueueShortFormPackJob(
      contentPack.id,
      source.id,
      transcript.id,
      user.id,
      undefined,
      db
    );
    assert.equal((queuedSnapshotJob!.payload as { generationRunId: string }).generationRunId, generationRunId);
    const [snapshotPackAfterQueue] = await db.select().from(schema.contentPacks)
      .where(eq(schema.contentPacks.id, contentPack.id));
    assert.equal(snapshotPackAfterQueue!.generationRunId, generationRunId);
    assert.equal(snapshotPackAfterQueue!.shortFormGenerationMode, 'snapshot');

    const [activationSource] = await db.insert(schema.sourceAssets).values({
      userId: user.id,
      projectId: project.id,
      title: 'Activation source',
      assetType: schema.SourceAssetType.UPLOADED_FILE,
      mimeType: 'video/mp4',
      storageKey: `snapshot/${randomUUID()}.mp4`,
      storageUrl: 'storage://snapshot/activation.mp4',
      status: schema.SourceAssetStatus.READY,
    }).returning();
    const [activationTranscript] = await db.insert(schema.transcripts).values({
      userId: user.id,
      sourceAssetId: activationSource!.id,
      content: 'Activation transcript',
      status: schema.TranscriptStatus.READY,
    }).returning();
    const activation = await activateSnapshotShortFormGeneration({
      projectId: project.id,
      sourceAssetId: activationSource!.id,
      userId: user.id,
      brandTemplateId: template.id,
      contentPackage: 'clips_only',
      clipLength: '15-30s',
      captionsEnabled: false,
      facecamDetectionEnabled: false,
    });
    assert.equal(activation.contentPack.shortFormGenerationMode, 'snapshot');
    assert.equal(activation.contentPack.generationRunId, activation.generationRunId);
    assert.equal(activation.snapshot.render.captionsEnabled, false);
    assert.equal(activation.snapshot.facecam.detectionEnabled, false);
    assert.equal(
      (activation.job.payload as { generationRunId: string }).generationRunId,
      activation.generationRunId
    );
    assert.deepEqual(
      await classifyShortFormGenerationMode({
        generationRunId: activation.generationRunId,
        contentPackId: activation.contentPack.id,
      }, db),
      { kind: 'snapshot', snapshot: activation.snapshot }
    );
    await db.update(schema.brandTemplates).set({ captionFontColor: '#000000' })
      .where(eq(schema.brandTemplates.id, template.id));
    const activationRun = await loadGenerationRun({
      generationRunId: activation.generationRunId,
      contentPackId: activation.contentPack.id,
    }, db);
    assert.equal(activationRun.snapshot.render.captionFontColor, '#ffffff');

    const [failedActivationSource] = await db.insert(schema.sourceAssets).values({
      userId: user.id,
      projectId: project.id,
      title: 'Failed activation source',
      assetType: schema.SourceAssetType.UPLOADED_FILE,
      mimeType: 'video/mp4',
      storageKey: `snapshot/${randomUUID()}.mp4`,
      storageUrl: 'storage://snapshot/failed-activation.mp4',
      status: schema.SourceAssetStatus.READY,
    }).returning();
    const runsBeforeFailedActivation = await db.select().from(schema.generationRuns);
    await assert.rejects(
      activateSnapshotShortFormGeneration({
        projectId: project.id,
        sourceAssetId: failedActivationSource!.id,
        userId: user.id,
        brandTemplateId: 999999999,
        contentPackage: 'clips_only',
      }),
      /Selected brand template was not found/,
    );
    assert.deepEqual(await db.select().from(schema.generationRuns), runsBeforeFailedActivation);
    assert.equal(
      (await db.query.contentPacks.findFirst({
        where: eq(schema.contentPacks.sourceAssetId, failedActivationSource!.id),
      })) ?? null,
      null,
    );

    const missingRunId = randomUUID();
    const [missingRunPack] = await db.insert(schema.contentPacks).values({
      userId: user.id,
      projectId: project.id,
      sourceAssetId: source.id,
      transcriptId: transcript.id,
      kind: schema.ContentPackKind.SHORT_FORM_CLIPS,
      name: 'Missing snapshot run',
      generationRunId: missingRunId,
      shortFormGenerationMode: 'snapshot',
    }).returning();
    assert.deepEqual(
      await classifyShortFormGenerationMode({ generationRunId: missingRunId, contentPackId: missingRunPack!.id }, db),
      { kind: 'invalid_snapshot_reference', code: 'generation_snapshot_missing_requires_regeneration' }
    );

    const [foreignRunPack] = await db.insert(schema.contentPacks).values({
      userId: user.id,
      projectId: project.id,
      sourceAssetId: source.id,
      transcriptId: transcript.id,
      kind: schema.ContentPackKind.SHORT_FORM_CLIPS,
      name: 'Foreign snapshot run',
      generationRunId,
      shortFormGenerationMode: 'snapshot',
    }).returning();
    assert.deepEqual(
      await classifyShortFormGenerationMode({ generationRunId, contentPackId: foreignRunPack!.id }, db),
      { kind: 'invalid_snapshot_reference', code: 'generation_snapshot_ownership_mismatch' }
    );

    const loaded = await loadGenerationRun({
      generationRunId,
      contentPackId: contentPack.id,
    }, db);
    assert.deepEqual(loaded.snapshot, snapshot);
    assert.deepEqual(
      await loadGenerationSnapshot({ generationRunId, contentPackId: contentPack.id }, db),
      snapshot
    );
    await assert.rejects(
      loadGenerationRun({ generationRunId, contentPackId: contentPack.id + 1 }, db),
      GenerationRunNotFoundError
    );
    await assert.rejects(
      loadGenerationSnapshot({ generationRunId: randomUUID() }, db),
      GenerationRunNotFoundError
    );

    await db.delete(schema.brandTemplates).where(eq(schema.brandTemplates.id, template.id));
    const afterTemplateDeletion = await loadGenerationRun({ generationRunId }, db);
    assert.equal(afterTemplateDeletion.selectedBrandTemplateId, null);
    assert.equal(afterTemplateDeletion.snapshot.brandTemplateId, template.id);

    const malformedId = randomUUID();
    await db.insert(schema.generationRuns).values({
      id: malformedId,
      contentPackId: contentPack.id,
      selectedBrandTemplateId: null,
      snapshot: { version: 1 },
    });
    await assert.rejects(loadGenerationRun({ generationRunId: malformedId }, db), InvalidGenerationSnapshotError);
    await db.update(schema.contentPacks).set({ generationRunId: malformedId })
      .where(eq(schema.contentPacks.id, contentPack.id));
    assert.deepEqual(
      await classifyShortFormGenerationMode({ generationRunId: malformedId, contentPackId: contentPack.id }, db),
      { kind: 'invalid_snapshot_reference', code: 'generation_snapshot_invalid_requires_regeneration' }
    );
    await db.update(schema.contentPacks).set({ generationRunId })
      .where(eq(schema.contentPacks.id, contentPack.id));
    await db.execute(sql`update content_packs set short_form_generation_mode = 'unknown' where id = ${contentPack.id}`);
    assert.deepEqual(
      await classifyShortFormGenerationMode({ generationRunId, contentPackId: contentPack.id }, db),
      { kind: 'invalid_snapshot_reference', code: 'generation_snapshot_mode_invalid' }
    );
    await db.update(schema.contentPacks).set({ shortFormGenerationMode: 'snapshot' })
      .where(eq(schema.contentPacks.id, contentPack.id));

    const [replacementTemplate] = await db.insert(schema.brandTemplates).values({
      userId: user.id,
      name: 'Replacement template',
    }).returning();
    const mismatchId = randomUUID();
    await db.insert(schema.generationRuns).values({
      id: mismatchId,
      contentPackId: contentPack.id,
      selectedBrandTemplateId: replacementTemplate.id,
      snapshot,
    });
    await assert.rejects(
      loadGenerationRun({ generationRunId: mismatchId }, db),
      GenerationRunSnapshotTemplateMismatchError
    );

    const nullSnapshotProvenanceId = randomUUID();
    await db.insert(schema.generationRuns).values({
      id: nullSnapshotProvenanceId,
      contentPackId: contentPack.id,
      selectedBrandTemplateId: replacementTemplate.id,
      snapshot: { ...snapshot, brandTemplateId: null },
    });
    await assert.rejects(
      loadGenerationRun({ generationRunId: nullSnapshotProvenanceId }, db),
      GenerationRunSnapshotTemplateMismatchError
    );

    const noTemplateId = randomUUID();
    await db.insert(schema.generationRuns).values({
      id: noTemplateId,
      contentPackId: contentPack.id,
      selectedBrandTemplateId: null,
      snapshot: { ...snapshot, brandTemplateId: null },
    });
    assert.equal(
      (await loadGenerationRun({ generationRunId: noTemplateId }, db)).snapshot
        .brandTemplateId,
      null
    );

    await db.delete(schema.contentPacks).where(eq(schema.contentPacks.id, contentPack.id));
    const runs = await db.select().from(schema.generationRuns)
      .where(eq(schema.generationRuns.contentPackId, contentPack.id));
    assert.deepEqual(runs, []);
  } finally {
    await appClient?.end();
    await admin.unsafe(`drop schema if exists "${schemaName}" cascade`);
    await admin.end();
  }
});
