import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { SignJWT } from 'jose';
import * as s from '../../lib/db/schema.ts';
import { remoteTestEnvironment } from '../../scripts/remote-test-support.mjs';
import { assertDisposablePostgresTestDatabase } from '../../lib/db/test-database-guard.ts';

// No worker is started: browser tests control completion at the external job boundary.
const configuredUrl = process.env.PHASE1A_TEST_DATABASE_URL;
if (!configuredUrl) throw new Error('Browser tests require PHASE1A_TEST_DATABASE_URL');
assertDisposablePostgresTestDatabase(configuredUrl);
const schemaName = `browser_${randomUUID().replaceAll('-', '')}`;
const admin = postgres(configuredUrl, { max: 1 });
await admin.unsafe(`create schema "${schemaName}"`);
await admin.unsafe(`set search_path to "${schemaName}"`);
for (const file of (await readdir('lib/db/migrations')).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
  for (const statement of (await readFile(join('lib/db/migrations', file), 'utf8')).split('--> statement-breakpoint')) {
    const sql = statement.trim().replaceAll('"public".', `"${schemaName}".`);
    if (sql) await admin.unsafe(sql);
  }
}
const isolatedUrl = new URL(configuredUrl);
isolatedUrl.searchParams.set('options', `-csearch_path=${schemaName}`);
const client = postgres(isolatedUrl.toString());
const db = drizzle(client, { schema: s });
const directory = await mkdtemp(join(tmpdir(), 'disburse-browser-'));
const videoPath = join(directory, 'gaming-fixture.mp4');
// Chromium distributions omit proprietary H.264/AAC decoders on some hosts.
// VP9/Opus in MP4 exercises real playback and delivery consistently; pipeline tests validate production H.264.
execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=180x320:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '3', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-movflags', '+faststart', videoPath], { timeout: 30_000 });
const media = await readFile(videoPath);
const objects = new Map<string, Buffer>();
const multipart = new Map<string, Map<number, Buffer>>();
const authSecret = 'browser-isolated-test-secret-no-live-credentials';
const [user] = await db.insert(s.users).values({ email: `${randomUUID()}@example.test`, passwordHash: 'fixture', name: 'Browser Creator' }).returning();
const [team] = await db.insert(s.teams).values({ name: 'Browser team' }).returning();
await db.insert(s.teamMembers).values({ userId: user!.id, teamId: team!.id, role: 'owner' });
const session = await new SignJWT({ user: { id: user!.id }, expires: new Date(Date.now() + 86_400_000).toISOString() }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1d').sign(new TextEncoder().encode(authSecret));
let candidateId = 0;
let packId = 0;
let currentArtifactId = 0;
let failedJobId = 0;

async function seedProject() {
  const prefix = randomUUID();
  const sourceKey = `${prefix}/source.mp4`;
  const currentKey = `${prefix}/current.mp4`;
  const historicalKey = `${prefix}/historical.mp4`;
  for (const key of [sourceKey, currentKey, historicalKey]) objects.set(`/browser/${key}`, media);
  const [project] = await db.insert(s.projects).values({ userId: user!.id, name: 'Browser gaming clips', isSaved: true }).returning();
  const [source] = await db.insert(s.sourceAssets).values({ userId: user!.id, projectId: project!.id, title: 'Browser gameplay', assetType: 'uploaded_file', status: 'ready', mimeType: 'video/mp4', storageKey: sourceKey, storageUrl: `http://127.0.0.1:3211/browser/${sourceKey}` }).returning();
  const [transcript] = await db.insert(s.transcripts).values({ userId: user!.id, sourceAssetId: source!.id, status: 'ready', content: 'Fixture gaming moment.' }).returning();
  const runId = randomUUID();
  const [pack] = await db.insert(s.contentPacks).values({ userId: user!.id, projectId: project!.id, sourceAssetId: source!.id, transcriptId: transcript!.id, kind: 'short_form_clips', name: 'Browser generation', status: 'generating', generationRunId: runId, shortFormGenerationMode: 'snapshot' }).returning();
  const { materializeGenerationSnapshot } = await import('../../lib/disburse/generation-snapshot.ts');
  const snapshot = materializeGenerationSnapshot({ brandTemplateId: null, ranking: { generationInstructions: '', clipLength: '30-60s', autoHookEnabled: true, contentPackage: 'clips_only' }, facecam: { detectionEnabled: false, detectorVersion: 'facecam_v2', preferredLayout: s.RenderedClipLayout.FACECAM_TOP_30, fallbackLayout: s.RenderedClipLayout.DEFAULT }, render: { aspectRatio: '9_16', captionsEnabled: false, captionStyle: 'default', captionFontAssetId: null, captionFontFamily: null, captionFontColor: '#ffffff', captionHighlightColor: '#facc15', captionPosition: 'bottom', captionAnimation: 'none', overlayLogoAssetId: null, introVideoAssetId: null, outroVideoAssetId: null, ctaUrl: null, cropSettings: {}, autoEditPreset: 'default_short_form_v1' } });
  await db.insert(s.generationRuns).values({ id: runId, contentPackId: pack!.id, snapshot });
  const [candidate] = await db.insert(s.clipCandidates).values({ userId: user!.id, sourceAssetId: source!.id, contentPackId: pack!.id, transcriptId: transcript!.id, generationRunId: runId, rank: 1, startTimeMs: 0, endTimeMs: 3000, durationMs: 3000, title: 'Current gaming moment', hook: 'A clutch moment', captionCopy: 'Fixture caption', summary: 'Fixture summary', transcriptExcerpt: 'Fixture gaming moment.', whyItWorks: 'Reaction', platformFit: 'Shorts', confidence: 90, facecamDetectionStatus: 'not_found' }).returning();
  const values = { userId: user!.id, sourceAssetId: source!.id, contentPackId: pack!.id, clipCandidateId: candidate!.id, generationRunId: runId };
  const [oldConfig] = await db.insert(s.clipRenderConfigs).values({ ...values, configHash: 'historical' }).returning();
  const [currentConfig] = await db.insert(s.clipRenderConfigs).values({ ...values, configHash: 'current' }).returning();
  await db.update(s.clipCandidates).set({ currentRenderConfigId: currentConfig!.id }).where(eq(s.clipCandidates.id, candidate!.id));
  const artifact = { ...values, title: candidate!.title, startTimeMs: 0, endTimeMs: 3000, durationMs: 3000, variant: 'vertical_short_form', layout: 'default', mimeType: 'video/mp4' };
  await db.insert(s.renderedClips).values({ ...artifact, clipRenderConfigId: oldConfig!.id, editConfigHash: 'historical', storageKey: historicalKey, status: 'ready' });
  const [current] = await db.insert(s.renderedClips).values({ ...artifact, clipRenderConfigId: currentConfig!.id, editConfigHash: 'current', storageKey: currentKey, status: 'pending' }).returning();
  const [job] = await db.insert(s.jobs).values({ type: s.JobType.FORMAT_RENDERED_CLIP_SHORT_FORM, status: 'failed', failureClass: s.JobFailureClass.SAFE_NO_EXTERNAL_EFFECT, failureReason: 'Fixture render failed before provider work', idempotencyKey: randomUUID(), payload: { ...values, renderConfigId: currentConfig!.id } }).returning();
  candidateId = candidate!.id; packId = pack!.id; currentArtifactId = current!.id; failedJobId = job!.id;
  return { projectId: project!.id, currentArtifactId, failedJobId };
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url!, 'http://127.0.0.1:3211');
    response.setHeader('access-control-allow-origin', 'http://127.0.0.1:3210');
    response.setHeader('access-control-allow-methods', 'GET, HEAD, POST, PUT, DELETE, OPTIONS');
    response.setHeader('access-control-allow-headers', '*');
    response.setHeader('access-control-expose-headers', 'ETag, Content-Length, Content-Range');
    if (request.method === 'OPTIONS') { response.end(); return; }
    const body: Buffer[] = [];
    for await (const chunk of request) body.push(Buffer.from(chunk));
    const bytes = Buffer.concat(body);
    const json = (value: unknown) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); };
    if (url.pathname === '/fixture/session') { json({ session }); return; }
    if (url.pathname === '/fixture/project' && request.method === 'POST') { json(await seedProject()); return; }
    if (url.pathname === '/fixture/ready' && request.method === 'POST') {
      await db.update(s.renderedClips).set({ status: 'ready' }).where(eq(s.renderedClips.id, currentArtifactId));
      await db.update(s.contentPacks).set({ status: 'ready' }).where(eq(s.contentPacks.id, packId));
      json({ candidateId }); return;
    }
    if (url.pathname === '/fixture/failed' && request.method === 'POST') {
      await db.update(s.renderedClips).set({ status: 'failed', failureReason: 'Fixture render failed' }).where(eq(s.renderedClips.id, currentArtifactId));
      await db.update(s.contentPacks).set({ status: 'failed' }).where(eq(s.contentPacks.id, packId));
      json({ failedJobId }); return;
    }
    if (url.pathname === '/fixture/recovery') { json(await db.select().from(s.jobs).where(eq(s.jobs.parentJobId, failedJobId))); return; }
    if (url.pathname === '/fixture/video') { response.setHeader('content-type', 'video/mp4'); response.end(media); return; }
    if (!url.pathname.startsWith('/browser/')) { response.statusCode = 404; response.end(); return; }
    if (request.method === 'POST' && url.searchParams.has('uploads')) {
      const id = randomUUID(); multipart.set(id, new Map()); response.end(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`); return;
    }
    const uploadId = url.searchParams.get('uploadId');
    if (uploadId) {
      const parts = multipart.get(uploadId)!;
      if (request.method === 'PUT') { parts.set(Number(url.searchParams.get('partNumber')), bytes); response.setHeader('ETag', '"browser-part"'); response.end(); return; }
      if (request.method === 'GET') { response.end(`<ListPartsResult><IsTruncated>false</IsTruncated>${[...parts].map(([number, data]) => `<Part><PartNumber>${number}</PartNumber><ETag>"browser-part"</ETag><Size>${data.length}</Size></Part>`).join('')}</ListPartsResult>`); return; }
      if (request.method === 'POST') { objects.set(url.pathname, Buffer.concat([...parts].sort(([a], [b]) => a - b).map(([, data]) => data))); response.end('<CompleteMultipartUploadResult/>'); return; }
    }
    if (request.method === 'PUT') { objects.set(url.pathname, bytes); response.setHeader('ETag', '"browser-object"'); response.end(); return; }
    const object = objects.get(url.pathname);
    if (!object) { response.statusCode = 404; response.end(); return; }
    response.setHeader('content-type', 'video/mp4'); response.setHeader('accept-ranges', 'bytes'); response.setHeader('ETag', '"browser-object"');
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Math.min(Number(range[2]), object.length - 1) : object.length - 1;
    if (range) { response.statusCode = 206; response.setHeader('content-range', `bytes ${start}-${end}/${object.length}`); }
    response.setHeader('content-length', end - start + 1);
    response.end(request.method === 'HEAD' ? undefined : object.subarray(start, end + 1));
  } catch (error) { console.error(error); response.statusCode = 500; response.end('Fixture failure'); }
});
await new Promise<void>((resolve) => server.listen(3211, '127.0.0.1', resolve));
const app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3210'], {
  stdio: 'inherit',
  env: { ...await remoteTestEnvironment(process.env, new URL('../../', import.meta.url)), NODE_ENV: 'production', POSTGRES_URL: isolatedUrl.toString(), AUTH_SECRET: authSecret, BASE_URL: 'http://127.0.0.1:3210', S3_UPLOAD_ACCESS_KEY_ID: 'browser-test', S3_UPLOAD_SECRET_ACCESS_KEY: 'browser-test', S3_UPLOAD_BUCKET: 'browser', S3_UPLOAD_REGION: 'auto', S3_UPLOAD_ENDPOINT: 'http://127.0.0.1:3211', S3_UPLOAD_PATH_STYLE: 'true', OPENAI_API_KEY: '', DEEPGRAM_API_KEY: '', ASSEMBLYAI_API_KEY: '', STRIPE_SECRET_KEY: 'sk_test_placeholder_browser_fixture', DISBURSE_ENABLE_DIRECT_PUBLISHING: 'false' },
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  app.kill('SIGTERM');
  server.close();
  await client.end();
  await admin.unsafe(`drop schema if exists "${schemaName}" cascade`);
  await admin.end();
  await rm(directory, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGTERM', close); process.on('SIGINT', close);
app.on('exit', close);
