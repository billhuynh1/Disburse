import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

register('../test/typescript-path-loader.mjs', import.meta.url);

const execFile = promisify(execFileCallback);
const configuredUrl = process.env.PHASE1A_TEST_DATABASE_URL;

type Branch = 'thumbnail' | 'render' | 'format' | 'candidate' | 'candidate-not-found' | 'legacy';

function requiredLoopbackDatabaseUrl() {
  assert.ok(
    configuredUrl?.trim(),
    'PHASE1A_TEST_DATABASE_URL is required for the S6b PostgreSQL suite'
  );
  let parsed: URL;
  try {
    parsed = new URL(configuredUrl!);
  } catch {
    assert.fail('PHASE1A_TEST_DATABASE_URL must be a valid loopback PostgreSQL URL');
  }
  assert.ok(
    ['127.0.0.1', 'localhost', '::1'].includes(parsed!.hostname),
    'PHASE1A_TEST_DATABASE_URL must use a loopback host'
  );
  return parsed!.toString();
}

function listen(server: Server) {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      resolve(address.port);
    });
  });
}

function close(server: Server) {
  return new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())
  );
}

function readBody(request: import('node:http').IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

test('S6b completed checkpoints preserve projections and resume production continuations', {
  skip: !configuredUrl,
}, async (t) => {
  const databaseUrl = requiredLoopbackDatabaseUrl();
  const { default: postgres } = await import('postgres');
  const databaseName = `disburse_s6b_${randomUUID().replaceAll('-', '')}`;
  const environmentKeys = [
    'POSTGRES_URL', 'DISBURSE_DEPLOYMENT_ENV', 'DISBURSE_STAGING_FAULT_INJECTION_ENABLED',
    'DISBURSE_FAULT_INJECTION', 'DISBURSE_FAULT_INJECTION_SECRET', 'S3_UPLOAD_ACCESS_KEY_ID',
    'S3_UPLOAD_SECRET_ACCESS_KEY', 'S3_UPLOAD_BUCKET', 'S3_UPLOAD_REGION', 'S3_UPLOAD_ENDPOINT',
    'S3_UPLOAD_PATH_STYLE', 'MEDIA_API_BASE_URL', 'MEDIA_API_SECRET', 'FFMPEG_PATH', 'FFPROBE_PATH',
  ] as const;
  const originalEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  let admin: { unsafe(query: string): Promise<unknown>; end(): Promise<void> } | null = null;
  let appClient: { end(): Promise<void> } | null = null;
  let storageServer: Server | null = null;
  let mediaServer: Server | null = null;
  let tempDir: string | null = null;
  let databaseCreated = false;
  let storageListening = false;
  let mediaListening = false;
  const networkAttempts: string[] = [];
  const providerCalls = { storage: 0, media: 0 };
  let notFound = false;

  try {
    const adminUrl = new URL(databaseUrl);
    adminUrl.pathname = '/postgres';
    adminUrl.search = '';
    admin = postgres(adminUrl.toString(), { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    databaseCreated = true;
    const isolatedUrl = new URL(databaseUrl);
    isolatedUrl.pathname = `/${databaseName}`;
    isolatedUrl.search = '';

    tempDir = await mkdtemp(path.join(tmpdir(), 'disburse-s6b-'));
    const ffmpeg = path.join(tempDir, 'ffmpeg');
    const ffprobe = path.join(tempDir, 'ffprobe');
    await writeFile(ffmpeg, '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.argv.at(-1), "s6b-render-output");\n');
    await writeFile(ffprobe, '#!/usr/bin/env node\nprocess.stdout.write("64x36\\n");\n');
    await chmod(ffmpeg, 0o755);
    await chmod(ffprobe, 0o755);

    storageServer = createServer(async (request, response) => {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      if (!url.pathname.startsWith('/s6b-bucket/') || !url.searchParams.has('X-Amz-Signature')) {
        response.writeHead(404).end();
        return;
      }
      if (request.method === 'GET' && url.pathname.endsWith('/source.mp4')) {
        response.writeHead(200, { 'Content-Type': 'video/mp4' }).end('s6b-source');
        return;
      }
      if (request.method === 'PUT') {
        providerCalls.storage += 1;
        await readBody(request);
        response.writeHead(200, { ETag: '"s6b-upload"' }).end();
        return;
      }
      response.writeHead(405).end();
    });
    mediaServer = createServer(async (request, response) => {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      if (request.method !== 'POST' || url.pathname !== '/internal/facecam-detections' || request.headers.authorization !== 'Bearer s6b-media-secret') {
        response.writeHead(404).end();
        return;
      }
      await readBody(request);
      providerCalls.media += 1;
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        frameWidth: 1920,
        frameHeight: 1080,
        sampledFrameCount: 1,
        candidates: notFound ? [] : [{ rank: 1, xPx: 0, yPx: 0, widthPx: 640, heightPx: 360, confidence: 90 }],
        detectionStage: 's6b-loopback',
        debugSummary: 'deterministic',
      }));
    });
    const storagePort = await listen(storageServer);
    storageListening = true;
    const mediaPort = await listen(mediaServer);
    mediaListening = true;
    const storageEndpoint = `http://127.0.0.1:${storagePort}`;
    const mediaEndpoint = `http://127.0.0.1:${mediaPort}`;

    await execFile('npm', ['run', 'db:migrate'], {
      cwd: new URL('../..', import.meta.url),
      env: { PATH: process.env.PATH!, POSTGRES_URL: isolatedUrl.toString(), NODE_ENV: 'test', DISBURSE_PIPELINE_KILL_SWITCH: 'true', STRIPE_SECRET_KEY: '', OPENAI_API_KEY: '' },
    });
    Object.assign(process.env, {
      POSTGRES_URL: isolatedUrl.toString(), DISBURSE_DEPLOYMENT_ENV: 'staging',
      DISBURSE_STAGING_FAULT_INJECTION_ENABLED: 'true', DISBURSE_FAULT_INJECTION_SECRET: 's6b-secret',
      S3_UPLOAD_ACCESS_KEY_ID: 's6b-access', S3_UPLOAD_SECRET_ACCESS_KEY: 's6b-secret',
      S3_UPLOAD_BUCKET: 's6b-bucket', S3_UPLOAD_REGION: 'us-east-1', S3_UPLOAD_ENDPOINT: storageEndpoint,
      S3_UPLOAD_PATH_STYLE: 'true', MEDIA_API_BASE_URL: mediaEndpoint, MEDIA_API_SECRET: 's6b-media-secret',
      FFMPEG_PATH: ffmpeg, FFPROBE_PATH: ffprobe,
    });
    globalThis.fetch = (async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.origin !== storageEndpoint && url.origin !== mediaEndpoint) {
        networkAttempts.push(`${init?.method || 'GET'} ${url.origin}`);
        throw new Error(`Unexpected network request: ${url.origin}`);
      }
      return await originalFetch(input, init);
    }) as typeof fetch;

    const { and, eq } = await import('drizzle-orm');
    const { db, client } = await import('../db/drizzle.ts');
    appClient = client;
    const schema = await import('../db/schema.ts');
    const { requestJobRecovery } = await import('./job-recovery-service.ts');
    const { processClaimedJob, productionPipelineProcessingRuntime } = await import('./pipeline-service.ts');
    const { reconcileShortFormContentPackStatus } = await import('./short-form-service.ts');
    const { runWithOperationalFaultAuthorization } = await import('./fault-injection.ts');
    const runtime = {
      ...productionPipelineProcessingRuntime,
      downstream: { trigger: () => undefined },
      timer: { startHeartbeat: () => null, stopHeartbeat: () => undefined },
    };

    const stableRun = (run: typeof schema.clipCandidateFacecamDetectionRuns.$inferSelect) => ({
      id: run.id, userId: run.userId, sourceAssetId: run.sourceAssetId,
      contentPackId: run.contentPackId, clipCandidateId: run.clipCandidateId,
      generationRunId: run.generationRunId, detectorVersion: run.detectorVersion,
      startTimeMs: run.startTimeMs, endTimeMs: run.endTimeMs, status: run.status,
      failureReason: run.failureReason, debugReason: run.debugReason,
      sampledFrameCount: run.sampledFrameCount, detectionStage: run.detectionStage,
      debugSummary: run.debugSummary, jobId: run.jobId,
    });
    const stableDetection = (detection: typeof schema.clipCandidateFacecamDetections.$inferSelect) => ({
      id: detection.id, userId: detection.userId, sourceAssetId: detection.sourceAssetId,
      clipCandidateId: detection.clipCandidateId, detectionRunId: detection.detectionRunId,
      generationRunId: detection.generationRunId, detectorVersion: detection.detectorVersion,
      rank: detection.rank, startTimeMs: detection.startTimeMs, endTimeMs: detection.endTimeMs,
      frameWidth: detection.frameWidth, frameHeight: detection.frameHeight, xPx: detection.xPx,
      yPx: detection.yPx, widthPx: detection.widthPx, heightPx: detection.heightPx,
      confidence: detection.confidence, sampledFrameCount: detection.sampledFrameCount,
    });
    const stableConfig = (config: typeof schema.clipEditConfigs.$inferSelect) => ({
      id: config.id, userId: config.userId, contentPackId: config.contentPackId,
      sourceAssetId: config.sourceAssetId, clipCandidateId: config.clipCandidateId,
      generationRunId: config.generationRunId, aspectRatio: config.aspectRatio,
      layout: config.layout, layoutRatio: config.layoutRatio, captionsEnabled: config.captionsEnabled,
      captionStyle: config.captionStyle, captionFontAssetId: config.captionFontAssetId,
      captionFontFamily: config.captionFontFamily, captionFontColor: config.captionFontColor,
      captionHighlightColor: config.captionHighlightColor, captionPosition: config.captionPosition,
      captionAnimation: config.captionAnimation, brandTemplateId: config.brandTemplateId,
      overlayLogoAssetId: config.overlayLogoAssetId, ctaUrl: config.ctaUrl,
      introVideoAssetId: config.introVideoAssetId, outroVideoAssetId: config.outroVideoAssetId,
      cropSettings: config.cropSettings, facecamDetectionId: config.facecamDetectionId,
      facecamDetected: config.facecamDetected, autoEditPreset: config.autoEditPreset,
      autoEditAppliedAt: config.autoEditAppliedAt, configVersion: config.configVersion,
      configHash: config.configHash,
    });
    const stableJob = (job: typeof schema.jobs.$inferSelect) => ({
      id: job.id, type: job.type, status: job.status, parentJobId: job.parentJobId,
      rootJobId: job.rootJobId, recoveryAttempt: job.recoveryAttempt,
      recoveryMode: job.recoveryMode, payload: job.payload,
    });
    const stableSegment = (segment: typeof schema.facecamSegments.$inferSelect) => ({
      id: segment.id, userId: segment.userId, videoId: segment.videoId,
      sourceAssetId: segment.sourceAssetId, rank: segment.rank, startTimeMs: segment.startTimeMs,
      endTimeMs: segment.endTimeMs, frameWidth: segment.frameWidth, frameHeight: segment.frameHeight,
      xPx: segment.xPx, yPx: segment.yPx, widthPx: segment.widthPx, heightPx: segment.heightPx,
      confidence: segment.confidence, layoutType: segment.layoutType,
      sampledFrameCount: segment.sampledFrameCount,
    });
    const stableNotification = (notification: typeof schema.notifications.$inferSelect) => ({
      id: notification.id, userId: notification.userId, type: notification.type,
      status: notification.status, entityType: notification.entityType,
      entityId: notification.entityId, dedupeKey: notification.dedupeKey,
    });

    const claim = async (jobId: number) => {
      const [claimed] = await db.update(schema.jobs).set({
        status: schema.JobStatus.PROCESSING,
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
        startedAt: new Date(),
      }).where(eq(schema.jobs.id, jobId)).returning();
      assert.ok(claimed);
      return claimed;
    };

    const fixtureFor = async (branch: Branch) => {
      const suffix = randomUUID();
      const [user] = await db.insert(schema.users).values({ email: `s6b-${suffix}@example.test`, passwordHash: 'test' }).returning();
      const [project] = await db.insert(schema.projects).values({ userId: user.id, name: 'S6b', isSaved: true }).returning();
      const [source] = await db.insert(schema.sourceAssets).values({
        userId: user.id, projectId: project.id, title: 'S6b source', assetType: schema.SourceAssetType.UPLOADED_FILE,
        originalFilename: 'source.mp4', mimeType: 'video/mp4', storageKey: `s6b/${suffix}/source.mp4`,
        storageUrl: `${storageEndpoint}/s6b-bucket/s6b/${suffix}/source.mp4`, status: schema.SourceAssetStatus.READY,
      }).returning();
      const [transcript] = await db.insert(schema.transcripts).values({ userId: user.id, sourceAssetId: source.id, language: 'en', content: 'S6b transcript.', status: schema.TranscriptStatus.READY }).returning();
      await db.insert(schema.transcriptSegments).values({ transcriptId: transcript.id, sequence: 0, startTimeMs: 0, endTimeMs: 1_000, text: 'S6b transcript.' });
      const generationRunId = randomUUID();
      const [pack] = await db.insert(schema.contentPacks).values({ userId: user.id, projectId: project.id, sourceAssetId: source.id, transcriptId: transcript.id, kind: schema.ContentPackKind.SHORT_FORM_CLIPS, name: 'S6b pack', generationRunId, status: schema.ContentPackStatus.GENERATING }).returning();
      const [candidate] = await db.insert(schema.clipCandidates).values({
        userId: user.id, contentPackId: pack.id, sourceAssetId: source.id, transcriptId: transcript.id, generationRunId,
        rank: 1, startTimeMs: 100, endTimeMs: 900, durationMs: 800, hook: 'Hook', title: 'Title', captionCopy: 'Caption', summary: 'Summary', transcriptExcerpt: 'Excerpt', whyItWorks: 'Reason', platformFit: 'Video', confidence: 90,
        facecamDetectionStatus: branch === 'format' ? schema.FacecamDetectionStatus.NOT_FOUND : undefined,
      }).returning();
      const [run] = branch === 'candidate' || branch === 'candidate-not-found'
        ? await db.insert(schema.clipCandidateFacecamDetectionRuns).values({ userId: user.id, sourceAssetId: source.id, contentPackId: pack.id, clipCandidateId: candidate.id, generationRunId, detectorVersion: 's6b', startTimeMs: 100, endTimeMs: 900 }).returning()
        : [null];
      if (branch === 'format') await db.insert(schema.clipEditConfigs).values({ userId: user.id, contentPackId: pack.id, sourceAssetId: source.id, clipCandidateId: candidate.id, generationRunId, configHash: `s6b-${suffix}`, captionsEnabled: false });
      const type = branch === 'thumbnail' ? schema.JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL
        : branch === 'render' ? schema.JobType.RENDER_CLIP_CANDIDATE
        : branch === 'format' ? schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM
        : schema.JobType.DETECT_CLIP_FACECAM;
      const payload = branch === 'thumbnail' ? { sourceAssetId: source.id, userId: user.id }
        : branch === 'render' || branch === 'format' ? { sourceAssetId: source.id, userId: user.id, contentPackId: pack.id, clipCandidateId: candidate.id, generationRunId, captionsEnabled: false }
        : branch === 'legacy' ? { sourceAssetId: source.id, userId: user.id, videoId: source.id, contentPackId: pack.id, generationRunId }
        : { sourceAssetId: source.id, userId: user.id, contentPackId: pack.id, clipCandidateId: candidate.id, generationRunId, startTimeMs: 100, endTimeMs: 900, detectorVersion: 's6b', detectionRunId: run!.id };
      const [job] = await db.insert(schema.jobs).values({ type, status: schema.JobStatus.PENDING, idempotencyKey: `s6b-${suffix}`, payload: payload as never }).returning();
      return { user, source, transcript, pack, candidate, run, job };
    };

    const execute = async (
      branch: Branch,
      competingJob: 'relevant' | 'unrelated' | undefined = undefined
    ) => {
      notFound = branch === 'candidate-not-found';
      const fixture = await fixtureFor(branch);
      const beforeCalls = branch === 'thumbnail' || branch === 'render' || branch === 'format' ? providerCalls.storage : providerCalls.media;
      const claimed = await claim(fixture.job.id);
      process.env.DISBURSE_FAULT_INJECTION = `${branch === 'thumbnail' ? 's3' : branch === 'render' || branch === 'format' ? 'render' : 'facecam'}:after_checkpoint_persistence_before_finalization`;
      const original = await runWithOperationalFaultAuthorization('s6b-secret', async () => await processClaimedJob(claimed as never, runtime));
      delete process.env.DISBURSE_FAULT_INJECTION;
      assert.equal(original.status, 'failed');
      const [checkpoint] = await db.select().from(schema.jobEffectCheckpoints).where(eq(schema.jobEffectCheckpoints.jobId, fixture.job.id));
      const [failedJob] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, fixture.job.id));
      assert.equal(checkpoint.status, schema.JobEffectCheckpointStatus.COMPLETED);
      assert.ok(checkpoint.result);
      assert.equal(failedJob.status, schema.JobStatus.FAILED);
      assert.equal(failedJob.failureCode, 'durable_checkpoint_available');
      assert.equal(failedJob.failureClass, schema.JobFailureClass.DURABLE_CHECKPOINT);
      if (branch === 'candidate' || branch === 'candidate-not-found') {
        const [runBeforeRecovery] = await db.select().from(schema.clipCandidateFacecamDetectionRuns)
          .where(eq(schema.clipCandidateFacecamDetectionRuns.id, fixture.run!.id));
        const [candidateBeforeRecovery] = await db.select().from(schema.clipCandidates)
          .where(eq(schema.clipCandidates.id, fixture.candidate.id));
        const detectionsBeforeRecovery = await db.select().from(schema.clipCandidateFacecamDetections)
          .where(eq(schema.clipCandidateFacecamDetections.clipCandidateId, fixture.candidate.id));
        const configsBeforeRecovery = await db.select().from(schema.clipEditConfigs)
          .where(eq(schema.clipEditConfigs.clipCandidateId, fixture.candidate.id));
        const jobsBeforeRecovery = await db.select().from(schema.jobs);
        const formatJobsBeforeRecovery = jobsBeforeRecovery.filter((candidateJob) =>
          candidateJob.type === schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM &&
          (candidateJob.payload as Record<string, unknown>).clipCandidateId === fixture.candidate.id
        );
        const notificationsBeforeRecovery = await db.select().from(schema.notifications)
          .where(eq(schema.notifications.userId, fixture.user.id));
        const expectedStatus = branch === 'candidate'
          ? schema.FacecamDetectionStatus.READY
          : schema.FacecamDetectionStatus.NOT_FOUND;
        assert.deepEqual(stableRun(runBeforeRecovery), {
          id: fixture.run!.id, userId: fixture.user.id, sourceAssetId: fixture.source.id,
          contentPackId: fixture.pack.id, clipCandidateId: fixture.candidate.id,
          generationRunId: fixture.pack.generationRunId, detectorVersion: 's6b',
          startTimeMs: 100, endTimeMs: 900, status: expectedStatus, failureReason: null,
          debugReason: null, sampledFrameCount: 1, detectionStage: 's6b-loopback',
          debugSummary: 'deterministic', jobId: fixture.job.id,
        });
        assert.deepEqual({ id: candidateBeforeRecovery.id, facecamDetectionStatus: candidateBeforeRecovery.facecamDetectionStatus, facecamDetectionFailureReason: candidateBeforeRecovery.facecamDetectionFailureReason }, {
          id: fixture.candidate.id, facecamDetectionStatus: expectedStatus, facecamDetectionFailureReason: null,
        });
        assert.deepEqual(detectionsBeforeRecovery.map(stableDetection), branch === 'candidate' ? [{
          id: detectionsBeforeRecovery[0]?.id, userId: fixture.user.id, sourceAssetId: fixture.source.id,
          clipCandidateId: fixture.candidate.id, detectionRunId: fixture.run!.id,
          generationRunId: fixture.pack.generationRunId, detectorVersion: 's6b', rank: 1,
          startTimeMs: 100, endTimeMs: 900, frameWidth: 1920, frameHeight: 1080,
          xPx: 0, yPx: 0, widthPx: 640, heightPx: 360, confidence: 90, sampledFrameCount: 1,
        }] : []);
        assert.equal(configsBeforeRecovery.length, 0);
        assert.equal(formatJobsBeforeRecovery.length, 0);
        assert.equal(notificationsBeforeRecovery.length, 0);
      }
      if (branch === 'legacy') {
        const segmentsBeforeRecovery = await db.select().from(schema.facecamSegments)
          .where(eq(schema.facecamSegments.videoId, fixture.source.id));
        const [candidateBeforeRecovery] = await db.select().from(schema.clipCandidates)
          .where(eq(schema.clipCandidates.id, fixture.candidate.id));
        const configsBeforeRecovery = await db.select().from(schema.clipEditConfigs)
          .where(eq(schema.clipEditConfigs.clipCandidateId, fixture.candidate.id));
        const jobsBeforeRecovery = await db.select().from(schema.jobs);
        const formatJobsBeforeRecovery = jobsBeforeRecovery.filter((candidateJob) =>
          candidateJob.type === schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM &&
          (candidateJob.payload as Record<string, unknown>).clipCandidateId === fixture.candidate.id
        );
        const publishingJobsBeforeRecovery = jobsBeforeRecovery.filter((candidateJob) =>
          candidateJob.type === schema.JobType.PUBLISH_RENDERED_CLIP &&
          (candidateJob.payload as Record<string, unknown>).sourceAssetId === fixture.source.id
        );
        const notificationsBeforeRecovery = await db.select().from(schema.notifications)
          .where(eq(schema.notifications.userId, fixture.user.id));
        assert.deepEqual(segmentsBeforeRecovery.map(stableSegment), [{
          id: segmentsBeforeRecovery[0]?.id, userId: fixture.user.id, videoId: fixture.source.id,
          sourceAssetId: fixture.source.id, rank: 1, startTimeMs: 0, endTimeMs: 1000,
          frameWidth: 1920, frameHeight: 1080, xPx: 0, yPx: 0, widthPx: 640,
          heightPx: 360, confidence: 90, layoutType: schema.RenderedClipLayout.FACECAM_TOP_40,
          sampledFrameCount: 1,
        }]);
        assert.deepEqual({ id: candidateBeforeRecovery.id, facecamDetectionStatus: candidateBeforeRecovery.facecamDetectionStatus, facecamDetectionFailureReason: candidateBeforeRecovery.facecamDetectionFailureReason }, {
          id: fixture.candidate.id, facecamDetectionStatus: fixture.candidate.facecamDetectionStatus,
          facecamDetectionFailureReason: fixture.candidate.facecamDetectionFailureReason,
        });
        assert.equal(configsBeforeRecovery.length, 0);
        assert.equal(formatJobsBeforeRecovery.length, 0);
        assert.equal(publishingJobsBeforeRecovery.length, 0);
        assert.equal(notificationsBeforeRecovery.length, 0);
      }
      if (branch === 'format') {
        const [packBeforeRecovery] = await db.select().from(schema.contentPacks).where(eq(schema.contentPacks.id, fixture.pack.id));
        const clipsBeforeRecovery = await db.select().from(schema.renderedClips).where(eq(schema.renderedClips.clipCandidateId, fixture.candidate.id));
        const notificationsBeforeRecovery = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, fixture.user.id));
        assert.equal(clipsBeforeRecovery[0]?.status, schema.RenderedClipStatus.READY);
        assert.equal(clipsBeforeRecovery[0]?.failureReason, null);
        assert.equal(packBeforeRecovery.status, schema.ContentPackStatus.GENERATING);
        assert.equal(packBeforeRecovery.failureReason, null);
        assert.equal(notificationsBeforeRecovery.filter((notification) => notification.type === 'rendered_clip' && notification.status === 'success').length, 1);
        assert.equal(notificationsBeforeRecovery.some((notification) => notification.type === 'rendered_clip' && notification.status === 'failed'), false);
      }
      const captureProjection = async () => {
        const [source] = await db.select().from(schema.sourceAssets)
          .where(eq(schema.sourceAssets.id, fixture.source.id));
        const [transcript] = await db.select().from(schema.transcripts)
          .where(eq(schema.transcripts.id, fixture.transcript.id));
        const [pack] = await db.select().from(schema.contentPacks)
          .where(eq(schema.contentPacks.id, fixture.pack.id));
        const [candidate] = await db.select().from(schema.clipCandidates)
          .where(eq(schema.clipCandidates.id, fixture.candidate.id));
        const variants = await db.select().from(schema.sourceAssetThumbnailVariants)
          .where(eq(schema.sourceAssetThumbnailVariants.sourceAssetId, fixture.source.id));
        const rendered = await db.select().from(schema.renderedClips)
          .where(eq(schema.renderedClips.clipCandidateId, fixture.candidate.id));
        const runs = await db.select().from(schema.clipCandidateFacecamDetectionRuns)
          .where(eq(schema.clipCandidateFacecamDetectionRuns.clipCandidateId, fixture.candidate.id));
        const detections = await db.select().from(schema.clipCandidateFacecamDetections)
          .where(eq(schema.clipCandidateFacecamDetections.clipCandidateId, fixture.candidate.id));
        const editConfigs = await db.select().from(schema.clipEditConfigs)
          .where(eq(schema.clipEditConfigs.clipCandidateId, fixture.candidate.id));
        const segments = await db.select().from(schema.facecamSegments)
          .where(eq(schema.facecamSegments.videoId, fixture.source.id));
        const notifications = await db.select().from(schema.notifications)
          .where(eq(schema.notifications.userId, fixture.user.id));
        const jobs = await db.select().from(schema.jobs);
        const scopedJobs = jobs.filter((job) => {
          const payload = job.payload as Record<string, unknown>;
          return payload.sourceAssetId === fixture.source.id ||
            payload.contentPackId === fixture.pack.id ||
            payload.clipCandidateId === fixture.candidate.id;
        });
        return JSON.parse(JSON.stringify({
          providerCallCount: branch === 'thumbnail' || branch === 'render' || branch === 'format'
            ? providerCalls.storage : providerCalls.media,
          source: {
            id: source.id, thumbnailStorageKey: source.thumbnailStorageKey,
            thumbnailMimeType: source.thumbnailMimeType, thumbnailWidth: source.thumbnailWidth,
            thumbnailHeight: source.thumbnailHeight, status: source.status,
            failureReason: source.failureReason,
          },
          transcript: {
            id: transcript.id, status: transcript.status, failureReason: transcript.failureReason,
          },
          variants: variants.map((variant) => ({
            id: variant.id, sourceAssetId: variant.sourceAssetId, variant: variant.variant,
            storageKey: variant.storageKey, mimeType: variant.mimeType, width: variant.width,
            height: variant.height,
          })),
          pack: { id: pack.id, status: pack.status, failureReason: pack.failureReason },
          candidate: {
            id: candidate.id,
            facecamDetectionStatus: candidate.facecamDetectionStatus,
            facecamDetectionFailureReason: candidate.facecamDetectionFailureReason,
          },
          rendered: rendered.map((clip) => ({
            id: clip.id, contentPackId: clip.contentPackId, clipCandidateId: clip.clipCandidateId,
            generationRunId: clip.generationRunId, editConfigId: clip.editConfigId,
            clipRenderConfigId: clip.clipRenderConfigId, editConfigVersion: clip.editConfigVersion,
            editConfigHash: clip.editConfigHash, variant: clip.variant, layout: clip.layout,
            storageKey: clip.storageKey, mimeType: clip.mimeType, fileSizeBytes: clip.fileSizeBytes,
            durationMs: clip.durationMs, status: clip.status, failureReason: clip.failureReason,
          })),
          runs: runs.map((run) => ({
            id: run.id, sourceAssetId: run.sourceAssetId, contentPackId: run.contentPackId,
            clipCandidateId: run.clipCandidateId, generationRunId: run.generationRunId,
            detectorVersion: run.detectorVersion, startTimeMs: run.startTimeMs,
            endTimeMs: run.endTimeMs, status: run.status, failureReason: run.failureReason,
            sampledFrameCount: run.sampledFrameCount, detectionStage: run.detectionStage,
            debugSummary: run.debugSummary,
          })),
          detections: detections.map((detection) => ({
            id: detection.id, detectionRunId: detection.detectionRunId,
            sourceAssetId: detection.sourceAssetId, clipCandidateId: detection.clipCandidateId,
            generationRunId: detection.generationRunId, detectorVersion: detection.detectorVersion,
            rank: detection.rank, startTimeMs: detection.startTimeMs, endTimeMs: detection.endTimeMs,
            frameWidth: detection.frameWidth, frameHeight: detection.frameHeight,
            xPx: detection.xPx, yPx: detection.yPx, widthPx: detection.widthPx,
            heightPx: detection.heightPx, confidence: detection.confidence,
            sampledFrameCount: detection.sampledFrameCount,
          })),
          editConfigs: editConfigs.map((config) => ({
            id: config.id, contentPackId: config.contentPackId, sourceAssetId: config.sourceAssetId,
            clipCandidateId: config.clipCandidateId, generationRunId: config.generationRunId,
            aspectRatio: config.aspectRatio, layout: config.layout, layoutRatio: config.layoutRatio,
            facecamDetectionId: config.facecamDetectionId, facecamDetected: config.facecamDetected,
            configVersion: config.configVersion, configHash: config.configHash,
          })),
          segments: segments.map((segment) => ({
            id: segment.id, videoId: segment.videoId, sourceAssetId: segment.sourceAssetId,
            rank: segment.rank, startTimeMs: segment.startTimeMs, endTimeMs: segment.endTimeMs,
            frameWidth: segment.frameWidth, frameHeight: segment.frameHeight, xPx: segment.xPx,
            yPx: segment.yPx, widthPx: segment.widthPx, heightPx: segment.heightPx,
            confidence: segment.confidence, layoutType: segment.layoutType,
            sampledFrameCount: segment.sampledFrameCount,
          })),
          notifications: notifications.map((notification) => ({
            id: notification.id, type: notification.type, status: notification.status,
            entityType: notification.entityType, entityId: notification.entityId,
            dedupeKey: notification.dedupeKey,
          })),
          formatJobs: scopedJobs.filter((job) => job.type === schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM)
            .map((job) => ({ id: job.id, status: job.status, payload: job.payload })),
          publishingJobs: scopedJobs.filter((job) => job.type === schema.JobType.PUBLISH_RENDERED_CLIP)
            .map((job) => ({ id: job.id, status: job.status, payload: job.payload })),
        }));
      };
      const projectionAfterOriginalFailure = await captureProjection();
      const recoveryInput = { userId: fixture.user.id, jobId: fixture.job.id, mode: schema.JobRecoveryMode.RESUME, idempotencyKey: `s6b-resume-${randomUUID()}`, requestedBy: 'user' as const };
      const recovery = await requestJobRecovery(recoveryInput);
      const duplicate = await requestJobRecovery(recoveryInput);
      assert.equal(recovery.outcome, schema.JobRecoveryOutcome.ACCEPTED);
      assert.equal(duplicate.successorJobId, recovery.successorJobId);
      const [successor] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, recovery.successorJobId!));
      assert.equal(successor.parentJobId, fixture.job.id);
      assert.equal(successor.rootJobId, fixture.job.id);
      assert.equal(successor.recoveryMode, schema.JobRecoveryMode.RESUME);
      assert.equal(successor.recoveryAttempt, 1);
      const successorClaim = await claim(successor.id);
      if (competingJob === 'relevant') {
        await db.insert(schema.jobs).values({
          type: schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
          status: schema.JobStatus.PENDING,
          idempotencyKey: `s6b-competing-${randomUUID()}`,
          payload: {
            sourceAssetId: fixture.source.id,
            userId: fixture.user.id,
            contentPackId: fixture.pack.id,
            clipCandidateId: fixture.candidate.id,
            generationRunId: fixture.pack.generationRunId,
            captionsEnabled: false,
          } as never,
        });
      }
      if (competingJob === 'unrelated') {
        await fixtureFor('format');
      }
      const resumed = await processClaimedJob(successorClaim as never, runtime);
      assert.equal(resumed.status, 'completed');
      const afterCalls = branch === 'thumbnail' || branch === 'render' || branch === 'format' ? providerCalls.storage : providerCalls.media;
      assert.equal(afterCalls - beforeCalls, 1);
      const [completed] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, successor.id));
      assert.equal(completed.status, schema.JobStatus.COMPLETED);
      const notifications = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, fixture.user.id));
      assert.equal(notifications.some((notification) => notification.status === 'failure'), false);
      const publishingJobs = await db.select().from(schema.jobs).where(eq(schema.jobs.type, schema.JobType.PUBLISH_RENDERED_CLIP));
      assert.equal(publishingJobs.length, 0);
      const [pack] = await db.select().from(schema.contentPacks).where(eq(schema.contentPacks.id, fixture.pack.id));
      const projectionAfterSuccessor = await captureProjection();
      return {
        fixture, notifications, pack, successor, successorClaim,
        projectionAfterOriginalFailure, projectionAfterSuccessor,
      };
    };

    const snapshotPersistedState = async (
      fixture: Awaited<ReturnType<typeof fixtureFor>>,
      originalJobId: number,
      successorJobId: number | null
    ) => {
      const jobsForFixture = (await db.select().from(schema.jobs)).filter((candidateJob) => {
        const payload = candidateJob.payload as Record<string, unknown>;
        return candidateJob.id === originalJobId || candidateJob.id === successorJobId ||
          payload.sourceAssetId === fixture.source.id ||
          payload.contentPackId === fixture.pack.id ||
          payload.clipCandidateId === fixture.candidate.id;
      });
      const [originalJob] = jobsForFixture.filter((candidateJob) => candidateJob.id === originalJobId);
      const successor = successorJobId === null
        ? null
        : jobsForFixture.find((candidateJob) => candidateJob.id === successorJobId) ?? null;
      const [checkpoint] = await db.select().from(schema.jobEffectCheckpoints)
        .where(eq(schema.jobEffectCheckpoints.jobId, originalJobId));
      const [source] = await db.select().from(schema.sourceAssets)
        .where(eq(schema.sourceAssets.id, fixture.source.id));
      const [transcript] = await db.select().from(schema.transcripts)
        .where(eq(schema.transcripts.id, fixture.transcript.id));
      const [pack] = await db.select().from(schema.contentPacks)
        .where(eq(schema.contentPacks.id, fixture.pack.id));
      const [candidate] = await db.select().from(schema.clipCandidates)
        .where(eq(schema.clipCandidates.id, fixture.candidate.id));
      const detectionRuns = await db.select().from(schema.clipCandidateFacecamDetectionRuns)
        .where(eq(schema.clipCandidateFacecamDetectionRuns.clipCandidateId, fixture.candidate.id));
      const detections = await db.select().from(schema.clipCandidateFacecamDetections)
        .where(eq(schema.clipCandidateFacecamDetections.clipCandidateId, fixture.candidate.id));
      const legacySegments = await db.select().from(schema.facecamSegments)
        .where(eq(schema.facecamSegments.videoId, fixture.source.id));
      const editConfigs = await db.select().from(schema.clipEditConfigs)
        .where(eq(schema.clipEditConfigs.clipCandidateId, fixture.candidate.id));
      const rendered = await db.select().from(schema.renderedClips)
        .where(eq(schema.renderedClips.clipCandidateId, fixture.candidate.id));
      const notifications = await db.select().from(schema.notifications)
        .where(eq(schema.notifications.userId, fixture.user.id));
      return JSON.parse(JSON.stringify({
        providerCalls: { ...providerCalls }, originalJob, successor, checkpoint, source,
        transcript, pack, candidate, detectionRuns, detections, legacySegments, editConfigs,
        rendered, notifications, downstreamJobs: jobsForFixture,
      }));
    };

    const assertOrdinaryThumbnailFailure = async (
      fixture: Awaited<ReturnType<typeof fixtureFor>>,
      storageCallsBeforeAttempt: number
    ) => {
      const [failedJob] = await db.select().from(schema.jobs)
        .where(eq(schema.jobs.id, fixture.job.id));
      const [source] = await db.select().from(schema.sourceAssets)
        .where(eq(schema.sourceAssets.id, fixture.source.id));
      const [transcript] = await db.select().from(schema.transcripts)
        .where(eq(schema.transcripts.id, fixture.transcript.id));
      const notifications = await db.select().from(schema.notifications)
        .where(eq(schema.notifications.userId, fixture.user.id));
      const scopedJobs = (await db.select().from(schema.jobs)).filter((job) => {
        const payload = job.payload as Record<string, unknown>;
        return job.id === fixture.job.id || payload.sourceAssetId === fixture.source.id ||
          payload.contentPackId === fixture.pack.id || payload.clipCandidateId === fixture.candidate.id;
      });

      assert.equal(failedJob.status, schema.JobStatus.FAILED);
      assert.equal(failedJob.failureReason, 'Thumbnail extraction failed.');
      assert.notEqual(failedJob.failureClass, schema.JobFailureClass.DURABLE_CHECKPOINT);
      assert.notEqual(failedJob.failureCode, 'durable_checkpoint_available');
      assert.equal(failedJob.leaseToken, null);
      assert.equal(failedJob.leaseExpiresAt, null);
      assert.equal(source.status, schema.SourceAssetStatus.FAILED);
      assert.equal(source.failureReason, 'Thumbnail extraction failed.');
      assert.equal(transcript.status, schema.TranscriptStatus.FAILED);
      assert.equal(transcript.failureReason, 'Thumbnail extraction failed.');
      assert.deepEqual(notifications.map((notification) => ({
        id: notification.id,
        type: notification.type,
        status: notification.status,
        entityType: notification.entityType,
        entityId: notification.entityId,
        dedupeKey: notification.dedupeKey,
      })), [{
        id: notifications[0]?.id,
        type: 'transcript',
        status: 'failure',
        entityType: 'transcript',
        entityId: fixture.transcript.id,
        dedupeKey: `transcript:${fixture.transcript.id}:failure:transcript:${fixture.transcript.id}:failed`,
      }]);
      assert.deepEqual(scopedJobs.map((job) => ({
        id: job.id,
        type: job.type,
        status: job.status,
        parentJobId: job.parentJobId,
        rootJobId: job.rootJobId,
        recoveryMode: job.recoveryMode,
        payload: job.payload,
      })), [{
        id: fixture.job.id,
        type: schema.JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL,
        status: schema.JobStatus.FAILED,
        parentJobId: null,
        rootJobId: null,
        recoveryMode: null,
        payload: { sourceAssetId: fixture.source.id, userId: fixture.user.id },
      }]);
      assert.equal(providerCalls.storage - storageCallsBeforeAttempt, 0);
    };

    await t.test('thumbnail preserves source and transcript readiness without transcript failure side effects', async () => {
      const {
        fixture, notifications, projectionAfterOriginalFailure, projectionAfterSuccessor,
      } = await execute('thumbnail');
      const [source] = await db.select().from(schema.sourceAssets).where(eq(schema.sourceAssets.id, fixture.source.id));
      const [transcript] = await db.select().from(schema.transcripts).where(eq(schema.transcripts.id, fixture.transcript.id));
      const variants = await db.select().from(schema.sourceAssetThumbnailVariants).where(eq(schema.sourceAssetThumbnailVariants.sourceAssetId, fixture.source.id));
      assert.equal(source.status, schema.SourceAssetStatus.READY);
      assert.equal(transcript.status, schema.TranscriptStatus.READY);
      assert.equal(transcript.failureReason, null);
      assert.equal(variants.length, 1);
      assert.equal(notifications.length, 0);
      assert.deepEqual(projectionAfterSuccessor.variants, projectionAfterOriginalFailure.variants);
      assert.deepEqual(projectionAfterSuccessor.source, projectionAfterOriginalFailure.source);
      assert.deepEqual(projectionAfterSuccessor.transcript, projectionAfterOriginalFailure.transcript);
      assert.deepEqual(projectionAfterSuccessor.notifications, projectionAfterOriginalFailure.notifications);
      assert.equal(projectionAfterOriginalFailure.providerCallCount, projectionAfterSuccessor.providerCallCount);
    });

    await t.test('original render retains its ready projection and one ready notification', async () => {
      const {
        fixture, notifications, projectionAfterOriginalFailure, projectionAfterSuccessor,
      } = await execute('render');
      const clips = await db.select().from(schema.renderedClips).where(eq(schema.renderedClips.clipCandidateId, fixture.candidate.id));
      assert.equal(clips.length, 1);
      assert.equal(clips[0]!.status, schema.RenderedClipStatus.READY);
      assert.ok(clips[0]!.storageKey);
      assert.equal(clips[0]!.failureReason, null);
      assert.deepEqual(notifications.map((notification) => ({
        type: notification.type, status: notification.status, entityType: notification.entityType,
        entityId: notification.entityId, dedupeKey: notification.dedupeKey,
      })), [{
        type: 'rendered_clip', status: 'success', entityType: 'rendered_clip', entityId: clips[0]!.id,
        dedupeKey: `rendered_clip:${clips[0]!.id}:success:render:${fixture.pack.generationRunId}:trimmed_original:default:default:ready`,
      }]);
      assert.deepEqual(projectionAfterSuccessor.rendered, projectionAfterOriginalFailure.rendered);
      assert.deepEqual(projectionAfterSuccessor.notifications, projectionAfterOriginalFailure.notifications);
      assert.equal(projectionAfterOriginalFailure.publishingJobs.length, 0);
      assert.equal(projectionAfterSuccessor.publishingJobs.length, 0);
      assert.equal(projectionAfterOriginalFailure.providerCallCount, projectionAfterSuccessor.providerCallCount);
    });

    await t.test('formatted render keeps the projection then reconciles the content pack', async () => {
      const {
        fixture, notifications, projectionAfterOriginalFailure, projectionAfterSuccessor,
      } = await execute('format');
      const clips = await db.select().from(schema.renderedClips).where(eq(schema.renderedClips.clipCandidateId, fixture.candidate.id));
      const [pack] = await db.select().from(schema.contentPacks).where(eq(schema.contentPacks.id, fixture.pack.id));
      assert.equal(clips.length, 1);
      assert.equal(clips[0]!.status, schema.RenderedClipStatus.READY);
      assert.equal(pack.status, schema.ContentPackStatus.READY);
      assert.equal(pack.failureReason, null);
      assert.deepEqual(notifications.map((notification) => ({
        type: notification.type, status: notification.status, entityType: notification.entityType,
        entityId: notification.entityId, dedupeKey: notification.dedupeKey,
      })), [
        {
          type: 'rendered_clip', status: 'success', entityType: 'rendered_clip', entityId: clips[0]!.id,
          dedupeKey: `rendered_clip:${clips[0]!.id}:success:render:${fixture.pack.generationRunId}:vertical_short_form:default:${clips[0]!.editConfigHash}:ready`,
        },
        {
          type: 'short_form_pack', status: 'success', entityType: 'content_pack', entityId: fixture.pack.id,
          dedupeKey: `short_form_pack:${fixture.pack.id}:success:generation:${fixture.pack.generationRunId}:ready`,
        },
      ]);
      assert.deepEqual(projectionAfterSuccessor.rendered, projectionAfterOriginalFailure.rendered);
      assert.equal(projectionAfterOriginalFailure.pack.status, schema.ContentPackStatus.GENERATING);
      assert.equal(projectionAfterSuccessor.pack.status, schema.ContentPackStatus.READY);
      assert.equal(projectionAfterOriginalFailure.providerCallCount, projectionAfterSuccessor.providerCallCount);
      assert.equal(projectionAfterSuccessor.publishingJobs.length, 0);
    });

    await t.test('formatted render excludes only its completing successor when another required format job remains active', async () => {
      const { pack } = await execute('format', 'relevant');
      assert.equal(pack.status, schema.ContentPackStatus.GENERATING);
      assert.equal(pack.failureReason, null);
    });

    await t.test('formatted render ignores active work outside its pack and generation scope', async () => {
      const { pack } = await execute('format', 'unrelated');
      assert.equal(pack.status, schema.ContentPackStatus.READY);
      assert.equal(pack.failureReason, null);
    });

    await t.test('null, omitted, undefined, and nonexistent completing job IDs do not suppress active format work', async () => {
      const fixture = await fixtureFor('format');
      const [editConfig] = await db.select().from(schema.clipEditConfigs).where(eq(schema.clipEditConfigs.clipCandidateId, fixture.candidate.id));
      assert.ok(editConfig);
      await db.insert(schema.renderedClips).values({
        userId: fixture.user.id,
        contentPackId: fixture.pack.id,
        sourceAssetId: fixture.source.id,
        clipCandidateId: fixture.candidate.id,
        generationRunId: fixture.pack.generationRunId,
        variant: schema.RenderedClipVariant.VERTICAL_SHORT_FORM,
        layout: editConfig.layout,
        editConfigId: editConfig.id,
        editConfigVersion: editConfig.configVersion,
        editConfigHash: editConfig.configHash,
        status: schema.RenderedClipStatus.READY,
        title: fixture.candidate.title,
        startTimeMs: fixture.candidate.startTimeMs,
        endTimeMs: fixture.candidate.endTimeMs,
        durationMs: fixture.candidate.durationMs,
        storageKey: `s6b-ready-${randomUUID()}.mp4`,
      });
      const reconciliationParams = {
        contentPackId: fixture.pack.id,
        sourceAssetId: fixture.source.id,
        generationRunId: fixture.pack.generationRunId,
      };
      await reconcileShortFormContentPackStatus(reconciliationParams);
      let [pack] = await db.select().from(schema.contentPacks).where(eq(schema.contentPacks.id, fixture.pack.id));
      assert.equal(pack.status, schema.ContentPackStatus.GENERATING);
      await reconcileShortFormContentPackStatus({
        ...reconciliationParams,
        completingJobId: undefined,
      });
      [pack] = await db.select().from(schema.contentPacks).where(eq(schema.contentPacks.id, fixture.pack.id));
      assert.equal(pack.status, schema.ContentPackStatus.GENERATING);
      await reconcileShortFormContentPackStatus({
        ...reconciliationParams,
        completingJobId: null,
      });
      [pack] = await db.select().from(schema.contentPacks).where(eq(schema.contentPacks.id, fixture.pack.id));
      assert.equal(pack.status, schema.ContentPackStatus.GENERATING);
      await reconcileShortFormContentPackStatus({
        ...reconciliationParams,
        completingJobId: fixture.job.id + 10_000_000,
      });
      [pack] = await db.select().from(schema.contentPacks).where(eq(schema.contentPacks.id, fixture.pack.id));
      assert.equal(pack.status, schema.ContentPackStatus.GENERATING);
      await reconcileShortFormContentPackStatus({
        ...reconciliationParams,
        completingJobId: fixture.job.id,
      });
      [pack] = await db.select().from(schema.contentPacks).where(eq(schema.contentPacks.id, fixture.pack.id));
      assert.equal(pack.status, schema.ContentPackStatus.READY);
      await db.insert(schema.jobs).values({
        type: schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
        status: schema.JobStatus.PENDING,
        idempotencyKey: `s6b-other-active-${randomUUID()}`,
        payload: {
          sourceAssetId: fixture.source.id,
          userId: fixture.user.id,
          contentPackId: fixture.pack.id,
          clipCandidateId: fixture.candidate.id,
          generationRunId: fixture.pack.generationRunId,
          captionsEnabled: false,
        } as never,
      });
      await reconcileShortFormContentPackStatus({
        ...reconciliationParams,
        completingJobId: fixture.job.id,
      });
      [pack] = await db.select().from(schema.contentPacks).where(eq(schema.contentPacks.id, fixture.pack.id));
      assert.equal(pack.status, schema.ContentPackStatus.GENERATING);
    });

    await t.test('candidate facecam detection preserves selected detection and queues one continuation', async () => {
      const {
        fixture, notifications, projectionAfterOriginalFailure, projectionAfterSuccessor,
      } = await execute('candidate');
      const { buildClipEditConfigHash } = await import('./clip-edit-config-utils.ts');
      const [run] = await db.select().from(schema.clipCandidateFacecamDetectionRuns).where(eq(schema.clipCandidateFacecamDetectionRuns.id, fixture.run!.id));
      const [candidate] = await db.select().from(schema.clipCandidates).where(eq(schema.clipCandidates.id, fixture.candidate.id));
      const detections = await db.select().from(schema.clipCandidateFacecamDetections).where(eq(schema.clipCandidateFacecamDetections.clipCandidateId, fixture.candidate.id));
      const [config] = await db.select().from(schema.clipEditConfigs).where(eq(schema.clipEditConfigs.clipCandidateId, fixture.candidate.id));
      const formatJobs = (await db.select().from(schema.jobs).where(eq(schema.jobs.type, schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM)))
        .filter((job) => {
          const payload = job.payload as Record<string, unknown>;
          return payload.projectId === undefined
            && payload.sourceAssetId === fixture.source.id
            && payload.contentPackId === fixture.pack.id
            && payload.clipCandidateId === fixture.candidate.id
            && payload.generationRunId === fixture.pack.generationRunId
            && payload.editConfigId === config?.id;
        });
      assert.deepEqual(stableRun(run), {
        id: fixture.run!.id, userId: fixture.user.id, sourceAssetId: fixture.source.id,
        contentPackId: fixture.pack.id, clipCandidateId: fixture.candidate.id,
        generationRunId: fixture.pack.generationRunId, detectorVersion: 's6b', startTimeMs: 100,
        endTimeMs: 900, status: schema.FacecamDetectionStatus.READY, failureReason: null,
        debugReason: null, sampledFrameCount: 1, detectionStage: 's6b-loopback',
        debugSummary: 'deterministic', jobId: fixture.job.id,
      });
      assert.deepEqual(detections.map(stableDetection), [{
        id: detections[0]?.id, userId: fixture.user.id, sourceAssetId: fixture.source.id,
        clipCandidateId: fixture.candidate.id, detectionRunId: fixture.run!.id,
        generationRunId: fixture.pack.generationRunId, detectorVersion: 's6b', rank: 1,
        startTimeMs: 100, endTimeMs: 900, frameWidth: 1920, frameHeight: 1080,
        xPx: 0, yPx: 0, widthPx: 640, heightPx: 360, confidence: 90, sampledFrameCount: 1,
      }]);
      assert.deepEqual({ id: candidate.id, status: candidate.facecamDetectionStatus, failureReason: candidate.facecamDetectionFailureReason }, {
        id: fixture.candidate.id, status: schema.FacecamDetectionStatus.READY, failureReason: null,
      });
      const expectedConfigHash = buildClipEditConfigHash({
        aspectRatio: '9_16', layout: schema.RenderedClipLayout.FACECAM_TOP_40, layoutRatio: '40_60',
        captionsEnabled: true, captionStyle: 'default', captionFontAssetId: null,
        captionFontFamily: null, captionFontColor: '#ffffff', captionHighlightColor: '#facc15',
        captionPosition: 'bottom', captionAnimation: 'none', brandTemplateId: null,
        overlayLogoAssetId: null, ctaUrl: null, introVideoAssetId: null, outroVideoAssetId: null,
        cropSettings: {}, facecamDetectionId: detections[0]!.id, facecamDetected: true,
        autoEditPreset: 'default_short_form_v1',
      });
      assert.deepEqual(stableConfig(config), {
        id: config.id, userId: fixture.user.id, contentPackId: fixture.pack.id, sourceAssetId: fixture.source.id,
        clipCandidateId: fixture.candidate.id, generationRunId: fixture.pack.generationRunId, aspectRatio: '9_16',
        layout: schema.RenderedClipLayout.FACECAM_TOP_40, layoutRatio: '40_60', captionsEnabled: true,
        captionStyle: 'default', captionFontAssetId: null, captionFontFamily: null, captionFontColor: '#ffffff',
        captionHighlightColor: '#facc15', captionPosition: 'bottom', captionAnimation: 'none', brandTemplateId: null,
        overlayLogoAssetId: null, ctaUrl: null, introVideoAssetId: null, outroVideoAssetId: null, cropSettings: {},
        facecamDetectionId: detections[0]!.id, facecamDetected: true, autoEditPreset: 'default_short_form_v1',
        autoEditAppliedAt: config.autoEditAppliedAt, configVersion: 2, configHash: expectedConfigHash,
      });
      assert.deepEqual(formatJobs.map(stableJob), [{
        id: formatJobs[0]?.id, type: schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
        status: schema.JobStatus.PENDING, parentJobId: null, rootJobId: null, recoveryAttempt: 0,
        recoveryMode: null, payload: {
          clipCandidateId: fixture.candidate.id, contentPackId: fixture.pack.id, sourceAssetId: fixture.source.id,
          userId: fixture.user.id, generationRunId: fixture.pack.generationRunId, editConfigId: config.id,
          variant: schema.RenderedClipVariant.VERTICAL_SHORT_FORM, layout: schema.RenderedClipLayout.FACECAM_TOP_40,
          captionsEnabled: true, editConfigHash: expectedConfigHash,
        },
      }]);
      assert.deepEqual(notifications.map(stableNotification), [{
        id: notifications[0]?.id, userId: fixture.user.id, type: 'facecam_detection', status: 'success',
        entityType: 'clip_candidate', entityId: fixture.candidate.id,
        dedupeKey: `facecam_detection:${fixture.candidate.id}:success:facecam:${fixture.run!.id}:${fixture.pack.generationRunId}:s6b:100-900:ready`,
      }]);
      assert.deepEqual(projectionAfterSuccessor.runs, projectionAfterOriginalFailure.runs);
      assert.deepEqual(projectionAfterSuccessor.detections, projectionAfterOriginalFailure.detections);
      assert.equal(projectionAfterOriginalFailure.editConfigs.length, 0);
      assert.equal(projectionAfterSuccessor.formatJobs.length, 1);
      assert.equal(projectionAfterSuccessor.publishingJobs.length, 0);
      assert.equal(projectionAfterOriginalFailure.providerCallCount, projectionAfterSuccessor.providerCallCount);
    });

    await t.test('candidate not-found continuation creates warning-only default-layout work', async () => {
      const {
        fixture, notifications, projectionAfterOriginalFailure, projectionAfterSuccessor,
      } = await execute('candidate-not-found');
      const { buildClipEditConfigHash } = await import('./clip-edit-config-utils.ts');
      const [run] = await db.select().from(schema.clipCandidateFacecamDetectionRuns).where(eq(schema.clipCandidateFacecamDetectionRuns.id, fixture.run!.id));
      const [candidate] = await db.select().from(schema.clipCandidates).where(eq(schema.clipCandidates.id, fixture.candidate.id));
      const detections = await db.select().from(schema.clipCandidateFacecamDetections).where(eq(schema.clipCandidateFacecamDetections.clipCandidateId, fixture.candidate.id));
      const [config] = await db.select().from(schema.clipEditConfigs).where(eq(schema.clipEditConfigs.clipCandidateId, fixture.candidate.id));
      const formatJobs = (await db.select().from(schema.jobs).where(eq(schema.jobs.type, schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM)))
        .filter((job) => (job.payload as Record<string, unknown>).clipCandidateId === fixture.candidate.id);
      assert.deepEqual(stableRun(run), {
        id: fixture.run!.id, userId: fixture.user.id, sourceAssetId: fixture.source.id,
        contentPackId: fixture.pack.id, clipCandidateId: fixture.candidate.id,
        generationRunId: fixture.pack.generationRunId, detectorVersion: 's6b', startTimeMs: 100,
        endTimeMs: 900, status: schema.FacecamDetectionStatus.NOT_FOUND, failureReason: null,
        debugReason: null, sampledFrameCount: 1, detectionStage: 's6b-loopback',
        debugSummary: 'deterministic', jobId: fixture.job.id,
      });
      assert.deepEqual(detections.map(stableDetection), []);
      assert.deepEqual({ id: candidate.id, status: candidate.facecamDetectionStatus, failureReason: candidate.facecamDetectionFailureReason }, {
        id: fixture.candidate.id, status: schema.FacecamDetectionStatus.NOT_FOUND, failureReason: null,
      });
      const expectedConfigHash = buildClipEditConfigHash({
        aspectRatio: '9_16', layout: schema.RenderedClipLayout.DEFAULT, layoutRatio: null,
        captionsEnabled: true, captionStyle: 'default', captionFontAssetId: null,
        captionFontFamily: null, captionFontColor: '#ffffff', captionHighlightColor: '#facc15',
        captionPosition: 'bottom', captionAnimation: 'none', brandTemplateId: null,
        overlayLogoAssetId: null, ctaUrl: null, introVideoAssetId: null, outroVideoAssetId: null,
        cropSettings: {}, facecamDetectionId: null, facecamDetected: false,
        autoEditPreset: 'default_short_form_v1',
      });
      assert.deepEqual(stableConfig(config), {
        id: config.id, userId: fixture.user.id, contentPackId: fixture.pack.id, sourceAssetId: fixture.source.id,
        clipCandidateId: fixture.candidate.id, generationRunId: fixture.pack.generationRunId, aspectRatio: '9_16',
        layout: schema.RenderedClipLayout.DEFAULT, layoutRatio: null, captionsEnabled: true, captionStyle: 'default',
        captionFontAssetId: null, captionFontFamily: null, captionFontColor: '#ffffff', captionHighlightColor: '#facc15',
        captionPosition: 'bottom', captionAnimation: 'none', brandTemplateId: null, overlayLogoAssetId: null,
        ctaUrl: null, introVideoAssetId: null, outroVideoAssetId: null, cropSettings: {}, facecamDetectionId: null,
        facecamDetected: false, autoEditPreset: 'default_short_form_v1', autoEditAppliedAt: config.autoEditAppliedAt,
        configVersion: 1, configHash: expectedConfigHash,
      });
      assert.deepEqual(formatJobs.map(stableJob), [{
        id: formatJobs[0]?.id, type: schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
        status: schema.JobStatus.PENDING, parentJobId: null, rootJobId: null, recoveryAttempt: 0,
        recoveryMode: null, payload: {
          clipCandidateId: fixture.candidate.id, contentPackId: fixture.pack.id, sourceAssetId: fixture.source.id,
          userId: fixture.user.id, generationRunId: fixture.pack.generationRunId, editConfigId: config.id,
          variant: schema.RenderedClipVariant.VERTICAL_SHORT_FORM, layout: schema.RenderedClipLayout.DEFAULT,
          captionsEnabled: true, editConfigHash: expectedConfigHash,
        },
      }]);
      assert.deepEqual(notifications.map(stableNotification), [{
        id: notifications[0]?.id, userId: fixture.user.id, type: 'facecam_detection', status: 'warning',
        entityType: 'clip_candidate', entityId: fixture.candidate.id,
        dedupeKey: `facecam_detection:${fixture.candidate.id}:warning:facecam:${fixture.run!.id}:${fixture.pack.generationRunId}:s6b:100-900:not_found`,
      }]);
      assert.deepEqual(projectionAfterSuccessor.runs, projectionAfterOriginalFailure.runs);
      assert.deepEqual(projectionAfterSuccessor.detections, projectionAfterOriginalFailure.detections);
      assert.equal(projectionAfterOriginalFailure.editConfigs.length, 0);
      assert.equal(projectionAfterSuccessor.formatJobs.length, 1);
      assert.equal(projectionAfterSuccessor.publishingJobs.length, 0);
      assert.equal(projectionAfterOriginalFailure.providerCallCount, projectionAfterSuccessor.providerCallCount);
    });

    await t.test('legacy facecam continuation uses the persisted segment and does not fall back', async () => {
      const { fixture, notifications, projectionAfterOriginalFailure, projectionAfterSuccessor } = await execute('legacy');
      const { buildClipEditConfigHash } = await import('./clip-edit-config-utils.ts');
      const segments = await db.select().from(schema.facecamSegments).where(eq(schema.facecamSegments.videoId, fixture.source.id));
      const [candidate] = await db.select().from(schema.clipCandidates).where(eq(schema.clipCandidates.id, fixture.candidate.id));
      const configs = await db.select().from(schema.clipEditConfigs).where(eq(schema.clipEditConfigs.clipCandidateId, fixture.candidate.id));
      const formatJobs = (await db.select().from(schema.jobs).where(eq(schema.jobs.type, schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM)))
        .filter((job) => (job.payload as Record<string, unknown>).clipCandidateId === fixture.candidate.id);
      const expectedConfigHash = buildClipEditConfigHash({
        aspectRatio: '9_16', layout: schema.RenderedClipLayout.FACECAM_TOP_40, layoutRatio: '40_60',
        captionsEnabled: true, captionStyle: 'default', captionFontAssetId: null,
        captionFontFamily: null, captionFontColor: '#ffffff', captionHighlightColor: '#facc15',
        captionPosition: 'bottom', captionAnimation: 'none', brandTemplateId: null,
        overlayLogoAssetId: null, ctaUrl: null, introVideoAssetId: null, outroVideoAssetId: null,
        cropSettings: {}, facecamDetectionId: null, facecamDetected: true,
        autoEditPreset: 'default_short_form_v1',
      });
      assert.deepEqual(segments.map(stableSegment), [{
        id: segments[0]?.id, userId: fixture.user.id, videoId: fixture.source.id,
        sourceAssetId: fixture.source.id, rank: 1, startTimeMs: 0, endTimeMs: 1000,
        frameWidth: 1920, frameHeight: 1080, xPx: 0, yPx: 0, widthPx: 640, heightPx: 360,
        confidence: 90, layoutType: schema.RenderedClipLayout.FACECAM_TOP_40, sampledFrameCount: 1,
      }]);
      assert.deepEqual({ id: candidate.id, status: candidate.facecamDetectionStatus, failureReason: candidate.facecamDetectionFailureReason }, {
        id: fixture.candidate.id, status: schema.FacecamDetectionStatus.READY, failureReason: null,
      });
      assert.deepEqual(configs.map(stableConfig), [{
        id: configs[0]?.id, userId: fixture.user.id, contentPackId: fixture.pack.id, sourceAssetId: fixture.source.id,
        clipCandidateId: fixture.candidate.id, generationRunId: fixture.pack.generationRunId, aspectRatio: '9_16',
        layout: schema.RenderedClipLayout.FACECAM_TOP_40, layoutRatio: '40_60', captionsEnabled: true,
        captionStyle: 'default', captionFontAssetId: null, captionFontFamily: null, captionFontColor: '#ffffff',
        captionHighlightColor: '#facc15', captionPosition: 'bottom', captionAnimation: 'none', brandTemplateId: null,
        overlayLogoAssetId: null, ctaUrl: null, introVideoAssetId: null, outroVideoAssetId: null, cropSettings: {},
        facecamDetectionId: null, facecamDetected: true, autoEditPreset: 'default_short_form_v1',
        autoEditAppliedAt: configs[0]?.autoEditAppliedAt, configVersion: 2, configHash: expectedConfigHash,
      }]);
      assert.deepEqual(formatJobs.map(stableJob), [{
        id: formatJobs[0]?.id, type: schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
        status: schema.JobStatus.PENDING, parentJobId: null, rootJobId: null, recoveryAttempt: 0,
        recoveryMode: null, payload: {
          clipCandidateId: fixture.candidate.id, contentPackId: fixture.pack.id, sourceAssetId: fixture.source.id,
          userId: fixture.user.id, generationRunId: fixture.pack.generationRunId, editConfigId: configs[0]!.id,
          variant: schema.RenderedClipVariant.VERTICAL_SHORT_FORM, layout: schema.RenderedClipLayout.FACECAM_TOP_40,
          captionsEnabled: true, editConfigHash: expectedConfigHash,
        },
      }]);
      assert.deepEqual(notifications.map(stableNotification), []);
      assert.deepEqual(projectionAfterSuccessor.segments, projectionAfterOriginalFailure.segments);
      assert.equal(projectionAfterOriginalFailure.editConfigs.length, 0);
      assert.equal(projectionAfterSuccessor.formatJobs.length, 1);
      assert.equal(projectionAfterSuccessor.publishingJobs.length, 0);
      assert.equal(projectionAfterOriginalFailure.providerCallCount, projectionAfterSuccessor.providerCallCount);
    });

    await t.test('only a completed typed checkpoint accepts resume recovery', async () => {
      const fixture = await fixtureFor('thumbnail');
      await db.update(schema.jobs).set({ status: schema.JobStatus.FAILED, failureClass: schema.JobFailureClass.DURABLE_CHECKPOINT, failureCode: 'durable_checkpoint_available' }).where(eq(schema.jobs.id, fixture.job.id));
      const result = await requestJobRecovery({ userId: fixture.user.id, jobId: fixture.job.id, mode: schema.JobRecoveryMode.RESUME, idempotencyKey: `s6b-missing-${randomUUID()}`, requestedBy: 'user' });
      assert.equal(result.code, 'resume_checkpoint_missing');
    });

    await t.test('missing, incomplete, malformed, and wrong-result-type checkpoints retain ordinary failure handling', async (t) => {
      const invalidStates = [
        { name: 'missing', status: null, result: null, checkpointJobType: null },
        { name: 'prepared', status: schema.JobEffectCheckpointStatus.PREPARED, result: null, checkpointJobType: schema.JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL },
        { name: 'started', status: schema.JobEffectCheckpointStatus.EXTERNAL_EFFECT_STARTED, result: null, checkpointJobType: schema.JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL },
        { name: 'completed absent result', status: schema.JobEffectCheckpointStatus.COMPLETED, result: null, checkpointJobType: schema.JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL },
        { name: 'completed malformed result', status: schema.JobEffectCheckpointStatus.COMPLETED, result: { jobType: schema.JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL }, checkpointJobType: schema.JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL },
        {
          name: 'completed wrong job type',
          status: schema.JobEffectCheckpointStatus.COMPLETED,
          result: {
            jobType: schema.JobType.DETECT_CLIP_FACECAM,
            sourceAssetId: 1,
            persistedAt: new Date(),
            contentPackId: null,
            clipCandidateId: null,
            videoId: 1,
            detectionRunId: null,
            generationRunId: null,
            status: schema.FacecamDetectionStatus.NOT_FOUND,
            detectionCount: 0,
          },
          checkpointJobType: schema.JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL,
        },
      ] as const;

      for (const invalid of invalidStates) {
        await t.test(invalid.name, async () => {
          const fixture = await fixtureFor('thumbnail');
          const storageCallsBeforeAttempt = providerCalls.storage;
          if (invalid.status) {
            await db.insert(schema.jobEffectCheckpoints).values({
              jobId: fixture.job.id,
              effectKey: 'primary_external_effect_v1',
              jobType: invalid.checkpointJobType!,
              status: invalid.status,
              result: invalid.result as never,
              externalEffectStartedAt: invalid.status === schema.JobEffectCheckpointStatus.EXTERNAL_EFFECT_STARTED ? new Date() : null,
              completedAt: invalid.status === schema.JobEffectCheckpointStatus.COMPLETED ? new Date() : null,
            });
          }
          const claimed = await claim(fixture.job.id);
          if (invalid.status === null || invalid.status === schema.JobEffectCheckpointStatus.PREPARED) {
            process.env.DISBURSE_FAULT_INJECTION = 's3:before_send';
          }
          const processed = await runWithOperationalFaultAuthorization(
            's6b-secret',
            async () => await processClaimedJob(claimed as never, runtime)
          );
          delete process.env.DISBURSE_FAULT_INJECTION;
          const safePreEffectFailure =
            invalid.status === null ||
            invalid.status === schema.JobEffectCheckpointStatus.PREPARED;
          if (safePreEffectFailure) {
            assert.equal(processed.status, 'requeued');
            const [job] = await db.select().from(schema.jobs)
              .where(eq(schema.jobs.id, fixture.job.id));
            const [source] = await db.select().from(schema.sourceAssets)
              .where(eq(schema.sourceAssets.id, fixture.source.id));
            const [transcript] = await db.select().from(schema.transcripts)
              .where(eq(schema.transcripts.id, fixture.transcript.id));
            assert.equal(job.status, schema.JobStatus.PENDING);
            assert.equal(job.leaseToken, null);
            assert.equal(job.leaseExpiresAt, null);
            assert.equal(source.status, schema.SourceAssetStatus.READY);
            assert.equal(transcript.status, schema.TranscriptStatus.READY);
            assert.equal(providerCalls.storage - storageCallsBeforeAttempt, 0);
          } else {
            assert.equal(processed.status, 'failed');
            await assertOrdinaryThumbnailFailure(fixture, storageCallsBeforeAttempt);
            const recovery = await requestJobRecovery({
              userId: fixture.user.id,
              jobId: fixture.job.id,
              mode: schema.JobRecoveryMode.RESUME,
              idempotencyKey: `s6b-invalid-${randomUUID()}`,
              requestedBy: 'user',
            });
            assert.equal(recovery.code, 'resume_checkpoint_missing');
          }
        });
      }
    });

    await t.test('checkpoint-row job-type mismatch is not a durable checkpoint and cannot resume', async () => {
      const fixture = await fixtureFor('thumbnail');
      const storageCallsBeforeAttempt = providerCalls.storage;
      await db.insert(schema.jobEffectCheckpoints).values({
        jobId: fixture.job.id,
        effectKey: 'primary_external_effect_v1',
        jobType: schema.JobType.DETECT_CLIP_FACECAM,
        status: schema.JobEffectCheckpointStatus.COMPLETED,
        result: {
          jobType: schema.JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL,
          sourceAssetId: fixture.source.id,
          thumbnailVariantId: null,
          persistedAt: new Date(),
        } as never,
        completedAt: new Date(),
      });
      const processed = await processClaimedJob(await claim(fixture.job.id) as never, runtime);
      assert.equal(processed.status, 'failed');
      await assertOrdinaryThumbnailFailure(fixture, storageCallsBeforeAttempt);
      const recovery = await requestJobRecovery({
        userId: fixture.user.id,
        jobId: fixture.job.id,
        mode: schema.JobRecoveryMode.RESUME,
        idempotencyKey: `s6b-row-type-${randomUUID()}`,
        requestedBy: 'user',
      });
      assert.equal(recovery.code, 'resume_checkpoint_missing');
    });

    await t.test('same-type checkpoint branch identity follows existing payload-based recovery eligibility', async () => {
      const fixture = await fixtureFor('thumbnail');
      process.env.DISBURSE_FAULT_INJECTION = 's3:after_checkpoint_persistence_before_finalization';
      const original = await runWithOperationalFaultAuthorization(
        's6b-secret',
        async () => await processClaimedJob(await claim(fixture.job.id) as never, runtime)
      );
      delete process.env.DISBURSE_FAULT_INJECTION;
      assert.equal(original.status, 'failed');
      const foreign = await fixtureFor('thumbnail');
      await db.update(schema.jobEffectCheckpoints).set({
        result: {
          jobType: schema.JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL,
          sourceAssetId: foreign.source.id,
          thumbnailVariantId: null,
          persistedAt: new Date(),
        } as never,
      }).where(eq(schema.jobEffectCheckpoints.jobId, fixture.job.id));
      const recovery = await requestJobRecovery({
        userId: fixture.user.id,
        jobId: fixture.job.id,
        mode: schema.JobRecoveryMode.RESUME,
        idempotencyKey: `s6b-branch-identity-${randomUUID()}`,
        requestedBy: 'user',
      });
      assert.equal(recovery.outcome, schema.JobRecoveryOutcome.ACCEPTED);
      const [successor] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, recovery.successorJobId!));
      const completed = await processClaimedJob(await claim(successor.id) as never, runtime);
      assert.equal(completed.status, 'completed');
    });

    await t.test('competing recovery request cannot create another active lineage leaf', async () => {
      const fixture = await fixtureFor('thumbnail');
      const claimed = await claim(fixture.job.id);
      process.env.DISBURSE_FAULT_INJECTION = 's3:after_checkpoint_persistence_before_finalization';
      await runWithOperationalFaultAuthorization('s6b-secret', async () => await processClaimedJob(claimed as never, runtime));
      delete process.env.DISBURSE_FAULT_INJECTION;
      const first = await requestJobRecovery({ userId: fixture.user.id, jobId: fixture.job.id, mode: schema.JobRecoveryMode.RESUME, idempotencyKey: `s6b-first-${randomUUID()}`, requestedBy: 'user' });
      const second = await requestJobRecovery({ userId: fixture.user.id, jobId: fixture.job.id, mode: schema.JobRecoveryMode.RESUME, idempotencyKey: `s6b-second-${randomUUID()}`, requestedBy: 'user' });
      assert.ok(first.successorJobId);
      assert.equal(second.code, 'latest_lineage_job_not_terminal');
    });

    await t.test('stale original authority leaves the completed candidate projection unchanged after successor creation', async () => {
      const fixture = await fixtureFor('candidate');
      notFound = false;
      const claimed = await claim(fixture.job.id);
      process.env.DISBURSE_FAULT_INJECTION = 'facecam:after_checkpoint_persistence_before_finalization';
      await runWithOperationalFaultAuthorization('s6b-secret', async () => await processClaimedJob(claimed as never, runtime));
      delete process.env.DISBURSE_FAULT_INJECTION;
      const recovery = await requestJobRecovery({ userId: fixture.user.id, jobId: fixture.job.id, mode: schema.JobRecoveryMode.RESUME, idempotencyKey: `s6b-stale-${randomUUID()}`, requestedBy: 'user' });
      assert.ok(recovery.successorJobId);
      const before = await snapshotPersistedState(fixture, fixture.job.id, recovery.successorJobId);
      const stale = await processClaimedJob(claimed as never, runtime);
      assert.equal(stale.status, 'lease_lost');
      const after = await snapshotPersistedState(fixture, fixture.job.id, recovery.successorJobId);
      assert.deepEqual(after, before);
    });

    await t.test('completed successor replay retains the completed checkpoint projection without duplicate work', async () => {
      const { fixture, successor, successorClaim } = await execute('format');
      const before = await snapshotPersistedState(fixture, fixture.job.id, successor.id);
      const replay = await processClaimedJob(successorClaim as never, runtime);
      assert.equal(replay.status, 'lease_lost');
      const after = await snapshotPersistedState(fixture, fixture.job.id, successor.id);
      assert.deepEqual(after, before);
      assert.equal(after.originalJob.status, schema.JobStatus.FAILED);
      assert.equal(after.originalJob.failureClass, schema.JobFailureClass.DURABLE_CHECKPOINT);
      assert.equal(after.successor.status, schema.JobStatus.COMPLETED);
      assert.equal(after.checkpoint.status, schema.JobEffectCheckpointStatus.COMPLETED);
      assert.equal(after.rendered.length, 1);
      assert.equal(after.pack.status, schema.ContentPackStatus.READY);
      assert.equal(after.notifications.filter((notification: { dedupeKey: string | null }) => notification.dedupeKey).length,
        before.notifications.filter((notification: { dedupeKey: string | null }) => notification.dedupeKey).length);
      assert.deepEqual(after.downstreamJobs.map((job: { id: number }) => job.id),
        before.downstreamJobs.map((job: { id: number }) => job.id));
      assert.equal(after.downstreamJobs.some((job: { type: string }) => job.type === schema.JobType.PUBLISH_RENDERED_CLIP), false);
    });

    await t.test('generation lifecycle invalidation cancels a claimed recovery successor before it can replay', async () => {
      const fixture = await fixtureFor('candidate');
      notFound = false;
      const claimedOriginal = await claim(fixture.job.id);
      process.env.DISBURSE_FAULT_INJECTION = 'facecam:after_checkpoint_persistence_before_finalization';
      await runWithOperationalFaultAuthorization('s6b-secret', async () => await processClaimedJob(claimedOriginal as never, runtime));
      delete process.env.DISBURSE_FAULT_INJECTION;
      const resume = await requestJobRecovery({
        userId: fixture.user.id,
        jobId: fixture.job.id,
        mode: schema.JobRecoveryMode.RESUME,
        idempotencyKey: `s6b-cancel-resume-${randomUUID()}`,
        requestedBy: 'user',
      });
      assert.ok(resume.successorJobId);
      const claimedSuccessor = await claim(resume.successorJobId);
      const [failedGeneration] = await db.insert(schema.jobs).values({
        type: schema.JobType.GENERATE_SHORT_FORM_PACK,
        status: schema.JobStatus.FAILED,
        idempotencyKey: `s6b-cancel-generation-${randomUUID()}`,
        payload: {
          contentPackId: fixture.pack.id,
          sourceAssetId: fixture.source.id,
          transcriptId: fixture.transcript.id,
          userId: fixture.user.id,
          generationRunId: fixture.pack.generationRunId,
        },
        failureReason: 'Superseded generation test fixture.',
        failureCode: 'external_effect_not_started',
        failureClass: schema.JobFailureClass.SAFE_NO_EXTERNAL_EFFECT,
        completedAt: new Date(),
      }).returning();
      const lifecycle = await requestJobRecovery({
        userId: fixture.user.id,
        jobId: failedGeneration.id,
        mode: schema.JobRecoveryMode.NEW_GENERATION,
        expectedCurrentGeneration: fixture.pack.generationRunId,
        idempotencyKey: `s6b-cancel-new-generation-${randomUUID()}`,
        requestedBy: 'user',
      });
      assert.equal(lifecycle.outcome, schema.JobRecoveryOutcome.ACCEPTED);
      const beforeStaleExecution = await snapshotPersistedState(
        fixture,
        fixture.job.id,
        resume.successorJobId
      );
      const staleResult = await processClaimedJob(claimedSuccessor as never, runtime);
      assert.equal(staleResult.status, 'lease_lost');
      const afterStaleExecution = await snapshotPersistedState(
        fixture,
        fixture.job.id,
        resume.successorJobId
      );
      assert.deepEqual(afterStaleExecution, beforeStaleExecution);
      assert.equal(afterStaleExecution.providerCalls.media, beforeStaleExecution.providerCalls.media);
      assert.equal(afterStaleExecution.originalJob.status, schema.JobStatus.FAILED);
      assert.equal(afterStaleExecution.originalJob.failureClass, schema.JobFailureClass.DURABLE_CHECKPOINT);
      assert.equal(afterStaleExecution.checkpoint.status, schema.JobEffectCheckpointStatus.COMPLETED);
      assert.equal(afterStaleExecution.successor.status, schema.JobStatus.CANCELLED);
      assert.equal(afterStaleExecution.successor.cancellationReason, 'generation_superseded');
      assert.equal(afterStaleExecution.detectionRuns[0]?.status, schema.FacecamDetectionStatus.READY);
      assert.equal(afterStaleExecution.detections.length, 1);
      assert.equal(afterStaleExecution.editConfigs.length, 0);
      assert.equal(afterStaleExecution.notifications.length, 0);
      assert.equal(afterStaleExecution.downstreamJobs.filter((job: { type: string; id: number }) =>
        job.type === schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM && job.id !== lifecycle.successorJobId
      ).length, 0);
    });

    await t.test('deletion-in-progress recovery preserves the completed format projection and persisted state', async () => {
      const fixture = await fixtureFor('format');
      const claimed = await claim(fixture.job.id);
      process.env.DISBURSE_FAULT_INJECTION = 'render:after_checkpoint_persistence_before_finalization';
      await runWithOperationalFaultAuthorization('s6b-secret', async () => await processClaimedJob(claimed as never, runtime));
      delete process.env.DISBURSE_FAULT_INJECTION;
      await db.update(schema.sourceAssets).set({ deletionRequestedAt: new Date() }).where(eq(schema.sourceAssets.id, fixture.source.id));
      const before = await snapshotPersistedState(fixture, fixture.job.id, null);
      const recovery = await requestJobRecovery({ userId: fixture.user.id, jobId: fixture.job.id, mode: schema.JobRecoveryMode.RESUME, idempotencyKey: `s6b-delete-${randomUUID()}`, requestedBy: 'user' });
      assert.equal(recovery.code, 'deletion_in_progress');
      const after = await snapshotPersistedState(fixture, fixture.job.id, null);
      assert.deepEqual(after, before);
      assert.equal(after.providerCalls.storage, before.providerCalls.storage);
      assert.equal(after.originalJob.status, schema.JobStatus.FAILED);
      assert.equal(after.originalJob.failureClass, schema.JobFailureClass.DURABLE_CHECKPOINT);
      assert.equal(after.checkpoint.status, schema.JobEffectCheckpointStatus.COMPLETED);
      assert.equal(after.rendered[0]?.status, schema.RenderedClipStatus.READY);
      assert.equal(after.pack.status, schema.ContentPackStatus.GENERATING);
      assert.equal(after.editConfigs.length, 1);
      assert.deepEqual(after.notifications.map((notification: { id: number; dedupeKey: string }) => [notification.id, notification.dedupeKey]),
        before.notifications.map((notification: { id: number; dedupeKey: string }) => [notification.id, notification.dedupeKey]));
      assert.deepEqual(after.downstreamJobs.map((job: { id: number; payload: unknown }) => [job.id, job.payload]),
        before.downstreamJobs.map((job: { id: number; payload: unknown }) => [job.id, job.payload]));
      assert.equal(after.downstreamJobs.filter((job: { type: string }) => job.type === schema.JobType.PUBLISH_RENDERED_CLIP).length,
        before.downstreamJobs.filter((job: { type: string }) => job.type === schema.JobType.PUBLISH_RENDERED_CLIP).length);
      assert.ok(after.source.deletionRequestedAt);
    });

    assert.deepEqual(networkAttempts, []);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of environmentKeys) {
      const value = originalEnvironment[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await appClient?.end().catch(() => undefined);
    if (storageListening && storageServer) await close(storageServer).catch(() => undefined);
    if (mediaListening && mediaServer) await close(mediaServer).catch(() => undefined);
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    if (databaseCreated && admin) await admin.unsafe(`drop database if exists "${databaseName}" with (force)`).catch(() => undefined);
    await admin?.end().catch(() => undefined);
  }
});
