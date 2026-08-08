import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, chmod, rm, writeFile } from 'node:fs/promises';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

register('../test/typescript-path-loader.mjs', import.meta.url);

const execFile = promisify(execFileCallback);
const configuredUrl = process.env.PHASE1A_TEST_DATABASE_URL;
const boundaries = [
  'before_send',
  'after_send_before_response',
  'after_provider_success_before_persistence',
  'after_checkpoint_persistence_before_finalization',
] as const;

type Boundary = typeof boundaries[number];
type Branch = 'thumbnail' | 'render' | 'format' | 'candidate-facecam' | 'legacy-facecam';
type Provider = 's3' | 'render' | 'facecam';

const branches: ReadonlyArray<{ name: Branch; provider: Provider }> = [
  { name: 'thumbnail', provider: 's3' },
  { name: 'render', provider: 'render' },
  { name: 'format', provider: 'render' },
  { name: 'candidate-facecam', provider: 'facecam' },
  { name: 'legacy-facecam', provider: 'facecam' },
];

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
  return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function readRequestBody(request: import('node:http').IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

test('S6a single-effect production job branches preserve fault boundaries', {
  skip: !configuredUrl,
}, async (t) => {
  const configured = new URL(configuredUrl!);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(configured.hostname));
  const databaseName = `disburse_s6_${randomUUID().replaceAll('-', '')}`;
  const { default: postgres } = await import('postgres');
  let admin: { unsafe(query: string): Promise<unknown>; end(): Promise<void> } | null = null;
  let databaseCreated = false;
  let tempDir: string | null = null;
  let fakeFfmpeg = '';
  let fakeFfprobe = '';
  let storageServer: Server | null = null;
  let mediaServer: Server | null = null;
  let storageListening = false;
  let mediaListening = false;
  const storage = {
    uploads: 0,
    reads: 0,
    rejected: [] as string[],
    requests: [] as Array<{ method: string; path: string; body: string; contentType: string | undefined }>,
  };
  const media = {
    requests: 0,
    rejected: [] as string[],
    nextStatus: 200,
    bodies: [] as Array<Record<string, unknown>>,
  };
  const environmentKeys = [
    'POSTGRES_URL', 'DISBURSE_DEPLOYMENT_ENV', 'DISBURSE_STAGING_FAULT_INJECTION_ENABLED',
    'DISBURSE_FAULT_INJECTION', 'DISBURSE_FAULT_INJECTION_SECRET', 'S3_UPLOAD_ACCESS_KEY_ID',
    'S3_UPLOAD_SECRET_ACCESS_KEY', 'S3_UPLOAD_BUCKET', 'S3_UPLOAD_REGION', 'S3_UPLOAD_ENDPOINT',
    'S3_UPLOAD_PATH_STYLE', 'MEDIA_API_BASE_URL', 'MEDIA_API_SECRET', 'FFMPEG_PATH', 'FFPROBE_PATH',
  ] as const;
  const originalEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  const originalConsoleInfo = console.info;
  const originalFetch = globalThis.fetch;
  const events: Array<Record<string, unknown>> = [];
  const networkAttempts: string[] = [];
  let appClient: { end(): Promise<void> } | null = null;

  try {
    const adminUrl = new URL(configuredUrl!);
    adminUrl.pathname = '/postgres';
    adminUrl.search = '';
    admin = postgres(adminUrl.toString(), { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    databaseCreated = true;
    const isolatedUrl = new URL(configuredUrl!);
    isolatedUrl.pathname = `/${databaseName}`;
    isolatedUrl.searchParams.delete('options');

    tempDir = await mkdtemp(path.join(tmpdir(), 'disburse-s6a-'));
    fakeFfmpeg = path.join(tempDir, 'ffmpeg');
    fakeFfprobe = path.join(tempDir, 'ffprobe');
    await writeFile(fakeFfmpeg, '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.argv.at(-1), "s6-render-output");\n');
    await writeFile(fakeFfprobe, '#!/usr/bin/env node\nprocess.stdout.write("64x36\\n");\n');
    await chmod(fakeFfmpeg, 0o755);
    await chmod(fakeFfprobe, 0o755);

    storageServer = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const validStoragePath = url.pathname.startsWith('/s6-bucket/');
    if (!validStoragePath || !url.searchParams.has('X-Amz-Signature')) {
      storage.rejected.push(`${request.method} ${url.pathname}`);
      response.writeHead(404).end();
      return;
    }
    if (request.method === 'GET' && url.pathname.endsWith('/source.mp4')) {
      storage.reads += 1;
      response.writeHead(200, { 'Content-Type': 'video/mp4' }).end('s6-source');
      return;
    }
    if (request.method === 'PUT' && !url.pathname.endsWith('/source.mp4')) {
      storage.uploads += 1;
      const body = await readRequestBody(request);
      storage.requests.push({
        method: request.method,
        path: url.pathname,
        body,
        contentType: request.headers['content-type'],
      });
      if (!body || !/^(image\/jpeg|video\/mp4|application\/octet-stream)/.test(request.headers['content-type'] || '')) {
        storage.rejected.push(`invalid upload ${url.pathname}`);
        response.writeHead(400).end();
        return;
      }
      response.writeHead(200, { ETag: '"s6-upload"' }).end();
      return;
    }
    storage.rejected.push(`${request.method} ${url.pathname}`);
    response.writeHead(405).end();
    });
    mediaServer = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (
      request.method !== 'POST' ||
      url.pathname !== '/internal/facecam-detections' ||
      request.headers.authorization !== 'Bearer s6-media-secret' ||
      request.headers['content-type'] !== 'application/json'
    ) {
      media.rejected.push(`${request.method} ${url.pathname}`);
      response.writeHead(404).end();
      return;
    }
    const body = JSON.parse(await readRequestBody(request)) as Record<string, unknown>;
    if (
      typeof body.sourceDownloadUrl !== 'string' || typeof body.sourceFilename !== 'string' ||
      typeof body.startTimeMs !== 'number' || typeof body.endTimeMs !== 'number'
    ) {
      media.rejected.push('invalid request body');
      response.writeHead(400).end();
      return;
    }
    media.requests += 1;
    media.bodies.push(body);
    if (media.nextStatus !== 200) {
      response.writeHead(media.nextStatus, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: 'deterministic media failure' }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      frameWidth: 1920, frameHeight: 1080, sampledFrameCount: 1,
      candidates: [{ rank: 1, xPx: 0, yPx: 0, widthPx: 640, heightPx: 360, confidence: 90 }],
      detectionStage: 's6-loopback', debugSummary: 'deterministic',
    }));
    });
    const storagePort = await listen(storageServer);
    storageListening = true;
    const mediaPort = await listen(mediaServer);
    mediaListening = true;
    const storageEndpoint = `http://127.0.0.1:${storagePort}`;
    const mediaEndpoint = `http://127.0.0.1:${mediaPort}`;

  const migrationEnvironment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH!,
    PGPASSWORD: process.env.PGPASSWORD!,
    POSTGRES_URL: isolatedUrl.toString(), NODE_ENV: 'test',
    DISBURSE_PIPELINE_KILL_SWITCH: 'true', STRIPE_SECRET_KEY: '', OPENAI_API_KEY: '',
  };
    await execFile('npm', ['run', 'db:migrate'], { cwd: new URL('../..', import.meta.url), env: migrationEnvironment });
    Object.assign(process.env, {
      POSTGRES_URL: isolatedUrl.toString(), DISBURSE_DEPLOYMENT_ENV: 'staging',
      DISBURSE_STAGING_FAULT_INJECTION_ENABLED: 'true', DISBURSE_FAULT_INJECTION_SECRET: 's6-matrix-secret',
      S3_UPLOAD_ACCESS_KEY_ID: 's6-access', S3_UPLOAD_SECRET_ACCESS_KEY: 's6-secret',
      S3_UPLOAD_BUCKET: 's6-bucket', S3_UPLOAD_REGION: 'us-east-1', S3_UPLOAD_ENDPOINT: storageEndpoint,
      S3_UPLOAD_PATH_STYLE: 'true', MEDIA_API_BASE_URL: mediaEndpoint, MEDIA_API_SECRET: 's6-media-secret',
      FFMPEG_PATH: fakeFfmpeg, FFPROBE_PATH: fakeFfprobe,
    });
    console.info = ((...args: unknown[]) => {
      const [serialized] = args;
      if (typeof serialized !== 'string' || !serialized.startsWith('{')) return;
      const parsed = JSON.parse(serialized) as Record<string, unknown>;
      if (parsed.event === 'pipeline.provider_boundary') events.push(parsed);
    }) as typeof console.info;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.origin !== storageEndpoint && url.origin !== mediaEndpoint) {
        networkAttempts.push(`${init?.method || 'GET'} ${url.origin}`);
        throw new Error(`Unexpected network request: ${url.origin}`);
      }
      return await originalFetch(input, init);
    }) as typeof fetch;

    const { eq } = await import('drizzle-orm');
    const { db, client } = await import('../db/drizzle.ts');
    appClient = client;
    const schema = await import('../db/schema.ts');
    const { claimNextJob } = await import('./job-service.ts');
    const { processClaimedJob, productionPipelineProcessingRuntime } = await import('./pipeline-service.ts');
    const { runWithOperationalFaultAuthorization } = await import('./fault-injection.ts');
    const { runWithOperationalInvocation } = await import('./operational-context.ts');

    const runtime = {
      ...productionPipelineProcessingRuntime,
      downstream: { trigger: () => undefined },
      timer: { startHeartbeat: () => null, stopHeartbeat: () => undefined },
    };
    const fixtureFor = async (branch: Branch) => {
      const suffix = randomUUID();
      const [user] = await db.insert(schema.users).values({ email: `s6-${suffix}@example.test`, passwordHash: 'test' }).returning();
      const [project] = await db.insert(schema.projects).values({ userId: user.id, name: 'S6 matrix', isSaved: true }).returning();
      const [sourceAsset] = await db.insert(schema.sourceAssets).values({
        userId: user.id, projectId: project.id, title: 'S6 video', assetType: schema.SourceAssetType.UPLOADED_FILE,
        originalFilename: branch === 'candidate-facecam' ? 'candidate-source.mp4' : branch === 'legacy-facecam' ? 'legacy-source.mp4' : 'source.mp4', mimeType: 'video/mp4', storageKey: `s6/${suffix}/source.mp4`,
        storageUrl: `${storageEndpoint}/s6-bucket/s6/${suffix}/source.mp4`, status: schema.SourceAssetStatus.READY,
      }).returning();
      const [transcript] = await db.insert(schema.transcripts).values({
        userId: user.id, sourceAssetId: sourceAsset.id, language: 'en', content: 'Source-grounded test transcript.', status: schema.TranscriptStatus.READY,
      }).returning();
      await db.insert(schema.transcriptSegments).values({ transcriptId: transcript.id, sequence: 0, startTimeMs: 0, endTimeMs: 1_000, text: 'Source-grounded test transcript.' });
      const generationRunId = randomUUID();
      const [contentPack] = await db.insert(schema.contentPacks).values({
        userId: user.id, projectId: project.id, sourceAssetId: sourceAsset.id, transcriptId: transcript.id,
        kind: schema.ContentPackKind.SHORT_FORM_CLIPS, name: 'S6 pack', generationRunId, status: schema.ContentPackStatus.PENDING,
      }).returning();
      const [candidate] = await db.insert(schema.clipCandidates).values({
        userId: user.id, contentPackId: contentPack.id, sourceAssetId: sourceAsset.id, transcriptId: transcript.id,
        generationRunId, rank: 1, startTimeMs: 100, endTimeMs: 900, durationMs: 800, hook: 'Hook', title: 'Title',
        captionCopy: 'Caption', summary: 'Summary', transcriptExcerpt: 'Excerpt', whyItWorks: 'Reason', platformFit: 'Video', confidence: 90,
      }).returning();
      const [detectionRun] = await db.insert(schema.clipCandidateFacecamDetectionRuns).values({
        userId: user.id, sourceAssetId: sourceAsset.id, contentPackId: contentPack.id, clipCandidateId: candidate.id,
        generationRunId, detectorVersion: 's6', startTimeMs: 100, endTimeMs: 900,
      }).returning();
      if (branch === 'format') await db.insert(schema.clipEditConfigs).values({
        userId: user.id, contentPackId: contentPack.id, sourceAssetId: sourceAsset.id, clipCandidateId: candidate.id,
        generationRunId, configHash: 's6-format-config', captionsEnabled: false,
      });
      const payload = branch === 'thumbnail' ? { sourceAssetId: sourceAsset.id, userId: user.id }
        : branch === 'render' || branch === 'format' ? { sourceAssetId: sourceAsset.id, userId: user.id, contentPackId: contentPack.id, clipCandidateId: candidate.id, generationRunId, captionsEnabled: false }
        : branch === 'candidate-facecam' ? { sourceAssetId: sourceAsset.id, userId: user.id, contentPackId: contentPack.id, clipCandidateId: candidate.id, generationRunId, startTimeMs: 100, endTimeMs: 900, detectorVersion: 's6', detectionRunId: detectionRun.id }
        : { sourceAssetId: sourceAsset.id, userId: user.id, videoId: sourceAsset.id };
      const type = branch === 'thumbnail' ? schema.JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL
        : branch === 'render' ? schema.JobType.RENDER_CLIP_CANDIDATE
        : branch === 'format' ? schema.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM
        : schema.JobType.DETECT_CLIP_FACECAM;
      const [job] = await db.insert(schema.jobs).values({ type, status: schema.JobStatus.PENDING, idempotencyKey: `s6-${suffix}`, payload: payload as never }).returning();
      return { job, user, project, sourceAsset, contentPack, candidate };
    };
    const runCase = async (branch: Branch, boundary: Boundary, sinkThrows = false) => {
      await db.update(schema.jobs).set({ status: schema.JobStatus.FAILED })
        .where(eq(schema.jobs.status, schema.JobStatus.PENDING));
      const fixture = await fixtureFor(branch);
      const claimed = await claimNextJob();
      assert.ok(claimed);
      assert.equal(claimed.id, fixture.job.id);
      storage.uploads = 0; storage.reads = 0; storage.requests.length = 0;
      media.requests = 0; media.bodies.length = 0; events.length = 0;
      process.env.DISBURSE_FAULT_INJECTION = `${branches.find((item) => item.name === branch)!.provider}:${boundary}`;
      let sinkAttempts = 0;
      const eventsAfterSinkFailure: Array<Record<string, unknown>> = [];
      if (sinkThrows) console.info = ((...args: unknown[]) => {
        sinkAttempts += 1;
        if (sinkAttempts === 1) throw new Error('s6 event sink failure');
        const [serialized] = args;
        if (typeof serialized === 'string' && serialized.startsWith('{')) {
          eventsAfterSinkFailure.push(JSON.parse(serialized) as Record<string, unknown>);
        }
        originalConsoleInfo(...args);
      }) as typeof console.info;
      const result = await runWithOperationalInvocation({ invocationId: '00000000-0000-4000-8000-000000000000', origin: 'internal' }, async () =>
        await runWithOperationalFaultAuthorization('s6-matrix-secret', async () => await processClaimedJob(claimed, runtime)));
      if (sinkThrows) console.info = originalConsoleInfo as typeof console.info;
      const [checkpoint] = await db.select().from(schema.jobEffectCheckpoints).where(eq(schema.jobEffectCheckpoints.jobId, claimed.id));
      const [persistedJob] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, claimed.id));
      const completed = boundary === 'after_checkpoint_persistence_before_finalization';
      const beforeSend = boundary === 'before_send';
      const calls = branch.includes('facecam') ? media.requests : storage.uploads;
      assert.equal(result.status, beforeSend ? 'requeued' : 'failed');
      assert.equal(calls, beforeSend ? 0 : 1);
      if (!beforeSend && !branch.includes('facecam')) {
        assert.equal(storage.requests.length, 1);
        const [upload] = storage.requests;
        assert.equal(upload.method, 'PUT');
        const expectedStorageKey = branch === 'thumbnail'
          ? `uploads/source-asset-thumbnails/${fixture.user.id}/${fixture.project.id}/${fixture.sourceAsset.id}/default.jpg`
          : `uploads/rendered-clips/${fixture.user.id}/${fixture.project.id}/clip-${fixture.candidate.id}-${branch === 'render' ? 'trimmed_original' : 'vertical_short_form'}.mp4`;
        assert.equal(upload.path, `/s6-bucket/${expectedStorageKey}`);
        assert.ok(upload.body.length > 0);
        assert.match(
          upload.contentType || '',
          branch === 'thumbnail' ? /^image\/jpeg/ : /^(video\/mp4|application\/octet-stream)/
        );
        assert.ok(!upload.path.endsWith('/source.mp4'));
      }
      if (!beforeSend && branch.includes('facecam')) {
        assert.equal(media.bodies.length, 1);
        const [body] = media.bodies;
        assert.equal(body.sourceFilename, fixture.sourceAsset.originalFilename);
        assert.equal(body.startTimeMs, branch === 'candidate-facecam' ? 100 : 0);
        assert.equal(body.endTimeMs, branch === 'candidate-facecam' ? 900 : 1_000);
        assert.match(String(body.sourceDownloadUrl), /^http:\/\/127\.0\.0\.1:\d+\/s6-bucket\/s6\//);
      }
      assert.equal(checkpoint.status, completed ? schema.JobEffectCheckpointStatus.COMPLETED : beforeSend ? schema.JobEffectCheckpointStatus.PREPARED : schema.JobEffectCheckpointStatus.EXTERNAL_EFFECT_STARTED);
      assert.equal(checkpoint.result === null, !completed);
      assert.equal(
        persistedJob.status,
        beforeSend ? schema.JobStatus.PENDING : schema.JobStatus.FAILED
      );
      assert.equal(
        persistedJob.failureCode,
        beforeSend
          ? null
          : completed
            ? 'durable_checkpoint_available'
            : 'external_effect_ambiguous'
      );
      assert.equal(
        persistedJob.failureClass,
        beforeSend
          ? null
          : completed
            ? schema.JobFailureClass.DURABLE_CHECKPOINT
            : schema.JobFailureClass.AMBIGUOUS_EXTERNAL_EFFECT
      );
      if (!sinkThrows) assert.deepEqual(events, [{ event: 'pipeline.provider_boundary', invocationId: '00000000-0000-4000-8000-000000000000', jobId: claimed.id, jobType: claimed.type, provider: branches.find((item) => item.name === branch)!.provider, boundary, failureClass: 'transient', failureCode: 'operational_fault_injected' }]);
      return { fixture, claimed, checkpoint, persistedJob, sinkAttempts, eventsAfterSinkFailure };
    };

    for (const branch of branches) for (const boundary of boundaries) {
      await t.test(`${branch.name} / ${boundary}`, async () => { await runCase(branch.name, boundary); });
    }

    await t.test('event sink failure preserves the injected fault, checkpoint, and job classification', async () => {
      const outcome = await runCase('thumbnail', 'after_send_before_response', true);
      assert.equal(outcome.sinkAttempts, 2);
      assert.deepEqual(outcome.eventsAfterSinkFailure.filter((event) => event.event === 'pipeline.provider_boundary'), []);
      assert.equal(outcome.checkpoint.status, schema.JobEffectCheckpointStatus.EXTERNAL_EFFECT_STARTED);
      assert.equal(outcome.persistedJob.failureCode, 'external_effect_ambiguous');
      assert.equal(outcome.persistedJob.failureClass, schema.JobFailureClass.AMBIGUOUS_EXTERNAL_EFFECT);
      assert.match(outcome.persistedJob.failureReason || '', /thumbnail/i);
    });

    await t.test('a throwing cause getter preserves the original ambiguous external-effect classification', async () => {
      await db.update(schema.jobs).set({ status: schema.JobStatus.FAILED })
        .where(eq(schema.jobs.status, schema.JobStatus.PENDING));
      const fixture = await fixtureFor('thumbnail');
      const claimed = await claimNextJob();
      assert.ok(claimed);
      events.length = 0;
      const providerFailure = new Error('loopback provider failure');
      Object.defineProperty(providerFailure, 'cause', {
        get() { throw new Error('cause getter failure'); },
      });
      const { AmbiguousExternalEffectError, runCheckpointedExternalEffect } =
        await import('./job-effect-checkpoint-service.ts');

      await assert.rejects(
        () => runCheckpointedExternalEffect(claimed, async (beginExternalEffect) => {
          await beginExternalEffect();
          throw providerFailure;
        }),
        (error: unknown) => {
          assert.ok(error instanceof AmbiguousExternalEffectError);
          assert.equal(error.cause, providerFailure);
          return true;
        }
      );
      const [checkpoint] = await db.select().from(schema.jobEffectCheckpoints)
        .where(eq(schema.jobEffectCheckpoints.jobId, claimed.id));
      assert.equal(checkpoint.status, schema.JobEffectCheckpointStatus.EXTERNAL_EFFECT_STARTED);
      assert.deepEqual(events, []);
      assert.equal(fixture.job.id, claimed.id);
    });

    await t.test('ordinary loopback Media API failure is not reported as an injected boundary event', async () => {
      await db.update(schema.jobs).set({ status: schema.JobStatus.FAILED })
        .where(eq(schema.jobs.status, schema.JobStatus.PENDING));
      const fixture = await fixtureFor('candidate-facecam');
      const claimed = await claimNextJob();
      assert.ok(claimed);
      media.requests = 0; events.length = 0; media.nextStatus = 500;
      delete process.env.DISBURSE_FAULT_INJECTION;
      const result = await processClaimedJob(claimed, runtime);
      media.nextStatus = 200;
      const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, claimed.id));
      assert.equal(result.status, 'failed');
      assert.equal(media.requests, 1);
      assert.deepEqual(events, []);
      assert.equal(job.failureCode, 'external_effect_ambiguous');
      assert.equal(job.failureClass, schema.JobFailureClass.AMBIGUOUS_EXTERNAL_EFFECT);
      assert.doesNotMatch(job.failureReason || '', /operational_fault_injected/i);
    });

    assert.deepEqual(storage.rejected, []);
    assert.deepEqual(media.rejected, []);
    assert.deepEqual(networkAttempts, []);
  } finally {
    console.info = originalConsoleInfo;
    globalThis.fetch = originalFetch;
    for (const key of environmentKeys) {
      const value = originalEnvironment[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await appClient?.end().catch(() => undefined);
    if (storageListening && storageServer) await close(storageServer).catch(() => undefined);
    if (mediaListening && mediaServer) await close(mediaServer).catch(() => undefined);
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    if (databaseCreated && admin) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`).catch(() => undefined);
    }
    await admin?.end().catch(() => undefined);
  }
});
