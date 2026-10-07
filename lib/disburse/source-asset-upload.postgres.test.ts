import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { assertDisposablePostgresTestDatabase } from '../db/test-database-guard.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

test('production upload persistence serializes completion and recovers verified storage effects', {
  skip: !process.env.PHASE1A_TEST_DATABASE_URL,
  timeout: 60_000,
}, async (t) => {
  const configuredUrl = process.env.PHASE1A_TEST_DATABASE_URL!;
  assertDisposablePostgresTestDatabase(configuredUrl);
  const schemaName = `upload_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(configuredUrl, { max: 1 });
  let appClient: { end: () => Promise<void> } | undefined;
  const objects = new Map<string, string | null>();
  const headRequests: string[] = [];
  const storage = createServer((req, res) => {
    assert.equal(req.method, 'HEAD');
    const key = decodeURIComponent(req.url!.replace('/test-bucket/', ''));
    headRequests.push(key);
    if (!objects.has(key)) { res.writeHead(404); res.end(); return; }
    const length = objects.get(key);
    res.writeHead(200, length === null ? {} : { 'content-length': length! }); res.end();
  });
  const previousEnv = { ...process.env };
  try {
    await new Promise<void>((resolve) => storage.listen(0, '127.0.0.1', resolve));
    const address = storage.address() as { port: number };
    Object.assign(process.env, {
      S3_UPLOAD_ACCESS_KEY_ID: 'test-only', S3_UPLOAD_SECRET_ACCESS_KEY: 'test-only',
      S3_UPLOAD_BUCKET: 'test-bucket', S3_UPLOAD_REGION: 'auto', S3_UPLOAD_PATH_STYLE: 'true',
      S3_UPLOAD_ENDPOINT: `http://127.0.0.1:${address.port}`,
    });
    await admin.unsafe(`create schema "${schemaName}"`);
    await admin.unsafe(`set search_path to "${schemaName}"`);
    const directory = new URL('../db/migrations/', import.meta.url);
    for (const file of (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
      for (const statement of (await readFile(new URL(file, directory), 'utf8')).split('--> statement-breakpoint')) {
        const scoped = statement.trim().replaceAll('"public".', `"${schemaName}".`);
        if (scoped) await admin.unsafe(scoped);
      }
    }
    const url = new URL(configuredUrl); url.searchParams.set('options', `-csearch_path=${schemaName}`);
    process.env.POSTGRES_URL = url.toString();
    const { db, client } = await import('../db/drizzle.ts'); appClient = client;
    const schema = await import('../db/schema.ts');
    const { createProductionSourceAssetUploadService } = await import('./source-asset-upload-service.ts');
    const [user] = await db.insert(schema.users).values({ email: `${randomUUID()}@example.com`, passwordHash: 'test' }).returning();
    const createUpload = async (name: string) => {
      const [project] = await db.insert(schema.projects).values({ userId: user.id, name, isSaved: true }).returning();
      const size = 5 * 1024 * 1024;
      const [session] = await db.insert(schema.sourceUploadSessions).values({
        userId: user.id, projectId: project.id, idempotencyKey: randomUUID(), originalFilename: 'source.mp4', mimeType: 'video/mp4',
        fileSizeBytes: size, storageKey: `uploads/${randomUUID()}.mp4`, uploadId: randomUUID(), partSizeBytes: size, totalParts: 1,
        status: schema.SourceUploadSessionStatus.UPLOADING,
      }).returning();
      await db.insert(schema.sourceUploadParts).values({ uploadSessionId: session.id, partNumber: 1, byteStart: 0, byteEnd: size - 1, sizeBytes: size, etag: '"part"', status: schema.SourceUploadPartStatus.UPLOADED });
      return { project, session, input: { uploadSessionId: session.id, title: name } };
    };
    const integrations = {
      listMultipartUploadParts: async () => [{ partNumber: 1, etag: '"part"' }],
      completeMultipartUpload: async () => {},
      createUploadCompletedNotification: async () => {},
    };
    const assertSingleSourceAndJob = async (sourceId: number, storageKey: string) => {
      const assets = await db.select().from(schema.sourceAssets).where(eq(schema.sourceAssets.storageKey, storageKey));
      assert.deepEqual(assets.map((asset) => asset.id), [sourceId]);
      const jobs = await db.select().from(schema.jobs);
      const matching = jobs.filter((job) => job.type === schema.JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL && (job.payload as { sourceAssetId?: number }).sourceAssetId === sourceId);
      assert.equal(matching.length, 1); assert.equal(matching[0].status, schema.JobStatus.PENDING);
    };

    await t.test('concurrent and repeated completion share one source and durable thumbnail job', async () => {
      const upload = await createUpload('concurrent');
      const started = deferred(); const release = deferred(); const waiterObserved = deferred(); let calls = 0;
      const service = createProductionSourceAssetUploadService({ ...integrations, completeMultipartUpload: async () => { calls++; started.resolve(); await release.promise; }, waitForCompletionStateChange: async () => { waiterObserved.resolve(); await new Promise((resolve) => setTimeout(resolve, 5)); } });
      const owner = service.completeSourceAssetUpload(upload.input, user); await started.promise;
      const waiter = service.completeSourceAssetUpload(upload.input, user); await waiterObserved.promise; release.resolve();
      const [first, second] = await Promise.all([owner, waiter]);
      const repeat = await service.completeSourceAssetUpload(upload.input, user);
      assert.equal(first.sourceAsset.id, second.sourceAsset.id); assert.equal(repeat.sourceAsset.id, first.sourceAsset.id); assert.equal(calls, 1);
      await assertSingleSourceAndJob(first.sourceAsset.id, upload.session.storageKey);
    });

    await t.test('lost completion response recovers only the exact committed key and size by real HEAD', async () => {
      const upload = await createUpload('ambiguous');
      const service = createProductionSourceAssetUploadService({ ...integrations, completeMultipartUpload: async ({ storageKey }) => { objects.set(storageKey, String(upload.session.fileSizeBytes)); throw new Error('Completion response lost'); } });
      const result = await service.completeSourceAssetUpload(upload.input, user);
      assert.ok(headRequests.includes(upload.session.storageKey)); await assertSingleSourceAndJob(result.sourceAsset.id, upload.session.storageKey);
    });

    await t.test('retry recovers a committed object after multipart session is gone', async () => {
      const upload = await createUpload('gone');
      await db.update(schema.sourceUploadSessions).set({ status: schema.SourceUploadSessionStatus.FAILED }).where(eq(schema.sourceUploadSessions.id, upload.session.id));
      objects.set(upload.session.storageKey, String(upload.session.fileSizeBytes));
      const service = createProductionSourceAssetUploadService({ ...integrations, listMultipartUploadParts: async () => { throw new Error('NoSuchUpload'); }, completeMultipartUpload: async () => { throw new Error('must not replay completion'); } });
      const result = await service.completeSourceAssetUpload(upload.input, user); await assertSingleSourceAndJob(result.sourceAsset.id, upload.session.storageKey);
    });

    await t.test('missing, wrong-size and unverified objects remain visible failures', async () => {
      for (const length of [undefined, '1', null]) {
        const upload = await createUpload('unverified'); if (length !== undefined) objects.set(upload.session.storageKey, length);
        const service = createProductionSourceAssetUploadService({ ...integrations, completeMultipartUpload: async () => { throw new Error('Completion result unknown'); } });
        await assert.rejects(service.completeSourceAssetUpload(upload.input, user), /Completion result unknown/);
        const [session] = await db.select().from(schema.sourceUploadSessions).where(eq(schema.sourceUploadSessions.id, upload.session.id));
        assert.equal(session.status, schema.SourceUploadSessionStatus.FAILED); assert.equal(session.sourceAssetId, null);
        assert.equal((await db.select().from(schema.sourceAssets).where(eq(schema.sourceAssets.storageKey, upload.session.storageKey))).length, 0);
      }
    });

    await t.test('persisted part validation cannot be bypassed by an existing same-size object', async () => {
      for (const invalid of ['missing', 'mismatch']) {
        const upload = await createUpload(`parts-${invalid}`);
        objects.set(upload.session.storageKey, String(upload.session.fileSizeBytes));
        if (invalid === 'missing') await db.delete(schema.sourceUploadParts).where(eq(schema.sourceUploadParts.uploadSessionId, upload.session.id));
        const service = createProductionSourceAssetUploadService({
          ...integrations,
          listMultipartUploadParts: async () => [{ partNumber: 1, etag: '"wrong"' }],
          completeMultipartUpload: async () => { throw new Error('invalid parts must not complete'); },
        });
        const headsBefore = headRequests.length;
        await assert.rejects(service.completeSourceAssetUpload(upload.input, user), /missing one or more parts|do not match storage state/);
        assert.equal(headRequests.length, headsBefore);
        assert.equal((await db.select().from(schema.sourceAssets).where(eq(schema.sourceAssets.storageKey, upload.session.storageKey))).length, 0);
      }
    });

    await t.test('deletion intent during external completion prevents media and job publication', async () => {
      const upload = await createUpload('deletion'); const started = deferred(); const release = deferred();
      const service = createProductionSourceAssetUploadService({ ...integrations, completeMultipartUpload: async () => { started.resolve(); await release.promise; } });
      const result = service.completeSourceAssetUpload(upload.input, user); const rejection = assert.rejects(result, /deleting project/i);
      await started.promise;
      await db.update(schema.projects).set({ deletionRequestedAt: new Date() }).where(eq(schema.projects.id, upload.project.id)); release.resolve(); await rejection;
      assert.equal((await db.select().from(schema.sourceAssets).where(eq(schema.sourceAssets.projectId, upload.project.id))).length, 0);
      const [session] = await db.select().from(schema.sourceUploadSessions).where(eq(schema.sourceUploadSessions.id, upload.session.id)); assert.equal(session.sourceAssetId, null);
    });
  } finally {
    await appClient?.end(); await admin.unsafe(`drop schema if exists "${schemaName}" cascade`); await admin.end();
    await new Promise<void>((resolve, reject) => storage.close((error) => error ? reject(error) : resolve()));
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  }
});
