import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { assertDisposablePostgresTestDatabase } from '../db/test-database-guard.ts';
import { createLoopbackMediaStorage, createSyntheticMedia, MEDIA_FIXTURE_DURATION_MS } from '../test/real-media-fixture.ts';

register('../test/typescript-path-loader.mjs', import.meta.url);
const execute = promisify(execFile);

test('activated snapshot jobs produce playable media without reconciliation repair', {
  skip: !process.env.PHASE1A_TEST_DATABASE_URL,
  timeout: 240_000,
}, async (t) => {
  const configuredUrl = process.env.PHASE1A_TEST_DATABASE_URL!;
  assertDisposablePostgresTestDatabase(configuredUrl);
  const schemaName = `pipeline_media_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(configuredUrl, { max: 1, onnotice() {} });
  const storage = await createLoopbackMediaStorage();
  const previousEnvironment = { ...process.env };
  let appClient: { end(): Promise<void> } | undefined;
  const inspectionDirectory = await mkdtemp(join(tmpdir(), 'disburse-inspect-'));
  try {
    Object.assign(process.env, storage.environment);
    // Each file has its own Node process; isolate cleanup assertions from parallel render suites.
    process.env.TMPDIR = inspectionDirectory;
    // No provider credentials are needed: only their external-operation boundaries are replaced.
    // Empty values also prevent dotenv from restoring local credentials on import.
    process.env.OPENAI_API_KEY = '';
    process.env.MEDIA_API_BASE_URL = '';
    await execute(process.env.FFMPEG_PATH || 'ffmpeg', ['-version']);
    await execute(process.env.FFPROBE_PATH || 'ffprobe', ['-version']);
    const font = await readFile(process.env.REMOTE_TEST_FONT_PATH || new URL('../../tests/fixtures/fonts/DejaVuSans.ttf', import.meta.url));
    storage.objects.set('font.ttf', font);
    storage.objects.set('audio.mp4', await createSyntheticMedia());
    storage.objects.set('silent.mp4', await createSyntheticMedia({ audio: false }));
    storage.objects.set('corrupt.mp4', Buffer.from('invalid mp4 input'));

    await admin.unsafe(`create schema "${schemaName}"`);
    await admin.unsafe(`set search_path to "${schemaName}"`);
    const migrationDirectory = new URL('../db/migrations/', import.meta.url);
    for (const file of (await readdir(migrationDirectory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
      for (const statement of (await readFile(new URL(file, migrationDirectory), 'utf8')).split('--> statement-breakpoint')) {
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
    const { activateSnapshotShortFormGeneration } = await import('./snapshot-generation-activation-service.ts');
    const { transcribeSourceAsset } = await import('./transcription-service.ts');
    const { generateShortFormPack } = await import('./short-form-service.ts');
    const { detectCandidateFacecam } = await import('./facecam-detection-service.ts');
    const { createPresignedDownload } = await import('./s3-storage.ts');
    const { claimNextJob } = await import('./job-service.ts');
    const { processClaimedJob, productionPipelineProcessingRuntime } = await import('./pipeline-service.ts');
    const [user] = await db.insert(schema.users).values({ email: `media-${randomUUID()}@example.test`, passwordHash: 'test' }).returning();
    const [fontAsset] = await db.insert(schema.reusableAssets).values({ userId: user!.id, kind: 'font', title: 'DejaVu Sans', originalFilename: 'DejaVuSans.ttf', mimeType: 'font/ttf', storageKey: 'font.ttf', storageUrl: 'storage://font.ttf', fileSizeBytes: font.length }).returning();
    const [template] = await db.insert(schema.brandTemplates).values({ userId: user!.id, name: 'Media fixture', aspectRatio: '9_16', defaultLayout: schema.RenderedClipLayout.FACECAM_TOP_30, captionFontAssetId: fontAsset!.id, captionFontFamily: 'DejaVu Sans', cropSettings: { sourceCrop: '1_1' } }).returning();
    const [landscapeTemplate] = await db.insert(schema.brandTemplates).values({ userId: user!.id, name: 'Landscape crop fixture', aspectRatio: '16_9', defaultLayout: schema.RenderedClipLayout.FACECAM_TOP_30, captionFontAssetId: fontAsset!.id, captionFontFamily: 'DejaVu Sans', cropSettings: { sourceCrop: '1_1' } }).returning();

    for (const scenario of [
      { name: 'usable facecam uses preferred split and captions', outcome: 'ready', source: 'audio.mp4', captions: true },
      { name: 'not-found falls back to cropped default with audio', outcome: 'not_found', source: 'audio.mp4', captions: false },
      { name: 'terminal detector failure falls back and silent media remains playable', outcome: 'failed', source: 'silent.mp4', captions: true },
      { name: 'corrupt media fails terminally without publishing or leaking render files', outcome: 'not_found', source: 'corrupt.mp4', captions: true },
    ] as const) {
      await t.test(scenario.name, async () => {
        const [project] = await db.insert(schema.projects).values({ userId: user!.id, name: scenario.name, isSaved: true }).returning();
        const sourceStorageKey = `${randomUUID()}/${scenario.source}`;
        storage.objects.set(sourceStorageKey, storage.objects.get(scenario.source)!);
        const [source] = await db.insert(schema.sourceAssets).values({ userId: user!.id, projectId: project!.id, title: scenario.name, assetType: schema.SourceAssetType.UPLOADED_FILE, status: schema.SourceAssetStatus.READY, originalFilename: scenario.source, storageKey: sourceStorageKey, storageUrl: `storage://${sourceStorageKey}`, mimeType: 'video/mp4' }).returning();
        assert.equal(await db.query.transcripts.findFirst({ where: eq(schema.transcripts.sourceAssetId, source!.id) }), undefined);
        const activation = await activateSnapshotShortFormGeneration({ userId: user!.id, projectId: project!.id, sourceAssetId: source!.id, brandTemplateId: scenario.captions ? template!.id : landscapeTemplate!.id, contentPackage: 'clips_only', clipLength: '15-30s', captionsEnabled: scenario.captions });
        assert.equal(activation.contentPack.transcriptId, null);
        let transcriptionCalls = 0;
        let rankingCalls = 0;
        let detectorCalls = 0;
        const runtime = {
          ...productionPipelineProcessingRuntime,
          downstream: { trigger() {} },
          processors: {
            ...productionPipelineProcessingRuntime.processors,
            transcribe: (id: number, authority: Parameters<typeof transcribeSourceAsset>[1]) => transcribeSourceAsset(id, authority, {
              async transcribe() {
                transcriptionCalls++;
                return { content: 'GAMING FIXTURE', language: 'en', segments: [{ sequence: 0, startTimeMs: 0, endTimeMs: MEDIA_FIXTURE_DURATION_MS, text: 'GAMING FIXTURE' }], words: [{ sequence: 0, startTimeMs: 0, endTimeMs: 7_500, text: 'GAMING' }, { sequence: 1, startTimeMs: 7_500, endTimeMs: MEDIA_FIXTURE_DURATION_MS, text: 'FIXTURE' }] };
              },
            }),
            generateShortForm: (id: number, run: string | undefined, authority: Parameters<typeof generateShortFormPack>[2]) => generateShortFormPack(id, run, authority, {
              async rankWindows({ windows }) {
                rankingCalls++;
                assert.equal(windows.length, 1);
                assert.equal(windows[0]!.durationMs, MEDIA_FIXTURE_DURATION_MS);
                return [{ windowId: windows[0]!.id, hook: 'GAMING FIXTURE', title: 'Fixture clip', captionCopy: 'GAMING FIXTURE', summary: 'Synthetic fixture', whyItWorks: 'Fixture', platformFit: 'Short', confidence: 95 }];
              },
              async generatePackageAssets() { throw new Error('clips_only must not call package generation'); },
            }),
            detectCandidateFacecam: (params: Parameters<typeof detectCandidateFacecam>[0]) => detectCandidateFacecam(params, {
              createDownload: createPresignedDownload,
              async detectRegions() {
                detectorCalls++;
                if (scenario.outcome === 'failed') throw new Error('fixture detector unavailable');
                return { frameWidth: 320, frameHeight: 180, sampledFrameCount: 30, candidates: scenario.outcome === 'ready' ? [{ rank: 1, xPx: 0, yPx: 0, widthPx: 80, heightPx: 60, confidence: 99 }] : [] };
              },
            }),
          },
        };
        const beforeTemps = new Set((await readdir(tmpdir())).filter((name) => name.startsWith('disburse-render-')));
        const processedTypes: string[] = [];
        for (let step = 0; step < 12; step++) {
          const job = await claimNextJob({ recoverExpiredLeases: false });
          if (!job) break;
          assert.ok('sourceAssetId' in job.payload);
          assert.equal(job.payload.sourceAssetId, source!.id);
          // Retry exhaustion is supplied at the test queue boundary; no state is repaired after dispatch.
          if (job.type === schema.JobType.DETECT_CLIP_FACECAM || scenario.source === 'corrupt.mp4') {
            await db.update(schema.jobs).set({ maxAttempts: job.attemptCount }).where(eq(schema.jobs.id, job.id));
            job.maxAttempts = job.attemptCount;
          }
          processedTypes.push(job.type);
          const result = await processClaimedJob(job, runtime);
          assert.notEqual(result.status, 'waiting_for_transcript', 'transcription should unblock normal generation dispatch');
          assert.notEqual(result.status, 'lease_lost');
        }
        assert.equal(transcriptionCalls, 1);
        assert.equal(rankingCalls, 1);
        assert.equal(detectorCalls, 1);
        assert.deepEqual(processedTypes, [schema.JobType.TRANSCRIBE_SOURCE_ASSET, schema.JobType.GENERATE_SHORT_FORM_PACK, schema.JobType.DETECT_CLIP_FACECAM, schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM]);
        const pack = await db.query.contentPacks.findFirst({ where: eq(schema.contentPacks.id, activation.contentPack.id) });
        const candidates = await db.select().from(schema.clipCandidates).where(eq(schema.clipCandidates.contentPackId, pack!.id));
        assert.equal(candidates.length, 1);
        const candidate = candidates[0]!;
        assert.equal(candidate.facecamDetectionStatus, scenario.outcome);
        const configs = await db.select().from(schema.clipRenderConfigs).where(eq(schema.clipRenderConfigs.clipCandidateId, candidate.id));
        assert.equal(configs.length, 1);
        assert.equal(candidate.currentRenderConfigId, configs[0]!.id);
        assert.equal(configs[0]!.layout, scenario.outcome === 'ready' ? schema.RenderedClipLayout.FACECAM_TOP_30 : schema.RenderedClipLayout.DEFAULT);
        assert.deepEqual(configs[0]!.cropSettings, { sourceCrop: '1_1' });
        const artifacts = await db.select().from(schema.renderedClips).where(eq(schema.renderedClips.clipCandidateId, candidate.id));
        assert.equal(artifacts.length, 1);
        assert.equal(artifacts[0]!.clipRenderConfigId, candidate.currentRenderConfigId);
        const jobs = (await db.select().from(schema.jobs)).filter((job) => (job.payload as { sourceAssetId: number }).sourceAssetId === source!.id);
        assert.equal(jobs.length, 4);
        for (const job of jobs) {
          const expectedFailure = (job.type === schema.JobType.DETECT_CLIP_FACECAM && scenario.outcome === 'failed') || (job.type === schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM && scenario.source === 'corrupt.mp4');
          assert.equal(job.status, expectedFailure ? schema.JobStatus.FAILED : schema.JobStatus.COMPLETED, `${job.type} terminal status`);
        }
        assert.deepEqual((await readdir(tmpdir())).filter((name) => name.startsWith('disburse-render-') && !beforeTemps.has(name)), []);
        const artifact = artifacts[0]!;
        if (scenario.source === 'corrupt.mp4') {
          assert.equal(pack!.status, schema.ContentPackStatus.FAILED);
          assert.equal(artifact.status, schema.RenderedClipStatus.FAILED);
          assert.ok(artifact.failureReason);
          assert.equal(jobs.find((job) => job.type === schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM)!.status, schema.JobStatus.FAILED);
          assert.equal(storage.objects.has(artifact.storageKey!), false);
          assert.equal(storage.requests.filter((request) => request.key === artifact.storageKey && request.method === 'PUT').length, 0);
          return;
        }
        assert.equal(pack!.status, schema.ContentPackStatus.READY);
        assert.equal(artifact.status, schema.RenderedClipStatus.READY);
        const downloaded = await fetch(createPresignedDownload({ storageKey: artifact.storageKey! }).downloadUrl);
        assert.equal(downloaded.status, 200);
        const outputPath = join(inspectionDirectory, `${candidate.id}.mp4`);
        await writeFile(outputPath, Buffer.from(await downloaded.arrayBuffer()));
        const { stdout } = await execute(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', outputPath], { timeout: 10_000 });
        const probe = JSON.parse(stdout) as { streams: Array<{ codec_type: string; width: number; height: number }>; format: { duration: string } };
        const video = probe.streams.find((stream) => stream.codec_type === 'video')!;
        const width = scenario.captions ? 1080 : 1920;
        const height = scenario.captions ? 1920 : 1080;
        assert.equal(video.width, width);
        assert.equal(video.height, height);
        assert.ok(Math.abs(Number(probe.format.duration) - MEDIA_FIXTURE_DURATION_MS / 1000) < 0.25);
        assert.equal(probe.streams.some((stream) => stream.codec_type === 'audio'), scenario.source !== 'silent.mp4');
        const { stdout: decoded } = await execute(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-ss', '1', '-i', outputPath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: width * height * 3 + 1024, timeout: 10_000 });
        const pixel = (x: number, y: number) => [...decoded.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)];
        const main = pixel(width / 2, Math.floor(height * 0.6));
        assert.ok(main[1]! > main[0]! + 50 && main[1]! > main[2]! + 50, 'main region must contain the center green crop');
        const top = pixel(width / 2, Math.floor(height * 0.1));
        if (scenario.outcome === 'ready') assert.ok(top[0]! > 180 && top[1]! < 50 && top[2]! < 50, 'facecam region must use the red detector box');
        else assert.ok(top[1]! > top[0]! + 50 && top[1]! > top[2]! + 50, 'fallback must crop the green center');
        if (!scenario.captions) {
          // Without the snapshot square crop this pixel would remain inside the red source corner.
          const croppedCorner = pixel(width / 8, Math.floor(height * 0.1));
          assert.ok(croppedCorner[1]! > croppedCorner[0]! + 50, 'sourceCrop must remove the original red corner before landscape resize');
        }
        let captionPixels = 0;
        for (let y = Math.floor(height * 0.7); y < Math.floor(height * 0.98); y++) for (let x = 80; x < width - 80; x++) {
          const offset = (y * width + x) * 3;
          if (decoded[offset]! > 200 && decoded[offset + 1]! > 200 && decoded[offset + 2]! > 200) captionPixels++;
        }
        assert.ok(scenario.captions ? captionPixels > 100 : captionPixels === 0, `caption pixels: ${captionPixels}`);
        assert.equal(storage.requests.filter((request) => request.key === artifact.storageKey && request.method === 'PUT').length, 1);
        assert.ok(storage.requests.some((request) => request.key === artifact.storageKey && request.method === 'HEAD'));
      });
    }
  } finally {
    if (appClient) await appClient.end();
    await admin.unsafe(`drop schema if exists "${schemaName}" cascade`);
    await admin.end();
    await storage.close();
    await rm(inspectionDirectory, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in previousEnvironment)) delete process.env[key];
    Object.assign(process.env, previousEnvironment);
  }
});
