import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { register } from 'node:module';
import test from 'node:test';
import postgres from 'postgres';
import { assertDisposablePostgresTestDatabase } from '../db/test-database-guard.ts';

register('../test/typescript-path-loader.mjs', import.meta.url);

test('temporary-media cleanup redacts every failure classification and the route returns only safe responses', {
  skip: !process.env.PHASE1A_TEST_DATABASE_URL,
}, async () => {
  const configuredUrl = process.env.PHASE1A_TEST_DATABASE_URL!;
  assertDisposablePostgresTestDatabase(configuredUrl);

  const schemaName = `cleanup_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(configuredUrl, { max: 1 });
  const originalFetch = globalThis.fetch;
  const originalEnvironment = {
    POSTGRES_URL: process.env.POSTGRES_URL,
    INTERNAL_PROCESSING_SECRET: process.env.INTERNAL_PROCESSING_SECRET,
    S3_UPLOAD_ACCESS_KEY_ID: process.env.S3_UPLOAD_ACCESS_KEY_ID,
    S3_UPLOAD_SECRET_ACCESS_KEY: process.env.S3_UPLOAD_SECRET_ACCESS_KEY,
    S3_UPLOAD_BUCKET: process.env.S3_UPLOAD_BUCKET,
    S3_UPLOAD_REGION: process.env.S3_UPLOAD_REGION,
    S3_UPLOAD_ENDPOINT: process.env.S3_UPLOAD_ENDPOINT,
    S3_UPLOAD_PATH_STYLE: process.env.S3_UPLOAD_PATH_STYLE,
  };
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
        const scopedStatement = statement.trim().replaceAll('"public".', `"${schemaName}".`);
        if (scopedStatement) await admin.unsafe(scopedStatement);
      }
    }

    const isolatedUrl = new URL(configuredUrl);
    isolatedUrl.searchParams.set('options', `-csearch_path=${schemaName}`);
    isolatedUrl.searchParams.set('application_name', `s4a_${schemaName}`);
    process.env.POSTGRES_URL = isolatedUrl.toString();
    process.env.INTERNAL_PROCESSING_SECRET = 's4a-cleanup-secret';
    process.env.S3_UPLOAD_ACCESS_KEY_ID = 'test-access-key';
    process.env.S3_UPLOAD_SECRET_ACCESS_KEY = 'test-secret-key';
    process.env.S3_UPLOAD_BUCKET = 'test-bucket';
    process.env.S3_UPLOAD_REGION = 'us-east-1';
    process.env.S3_UPLOAD_ENDPOINT = 'https://storage.invalid';
    process.env.S3_UPLOAD_PATH_STYLE = 'true';

    const rawFailures = new Map([
      ['pending-project-key', 'raw pending project provider body'],
      ['pending-source-key', 'raw pending source provider body'],
      ['project-key', 'raw project provider body'],
      ['source-key', 'raw source provider body'],
      ['clip-key', 'raw rendered clip provider body'],
      ['mixed-source-failure-key', 'raw mixed source provider body'],
    ]);
    globalThis.fetch = async (input) => {
      const url = String(input);
      const rawFailure = [...rawFailures.entries()].find(([key]) => url.includes(key))?.[1];
      if (rawFailure) throw new Error(`${rawFailure}: ${url}`);
      return new Response(null, { status: 204 });
    };

    const { client, db } = await import('../db/drizzle.ts');
    appClient = client;
    const schema = await import('../db/schema.ts');
    const { cleanupExpiredTemporaryMedia } = await import('./media-retention-service.ts');
    const { POST } = await import('../../app/api/internal/jobs/cleanup-expired-media/route.ts');
    const now = new Date('2026-07-01T00:00:00.000Z');
    const expiredAt = new Date('2026-01-01T00:00:00.000Z');
    const authorizedRequest = () => new Request('http://internal.test/cleanup', {
      method: 'POST',
      headers: { authorization: 'Bearer s4a-cleanup-secret' },
    });
    const createUser = async () => (await db.insert(schema.users).values({
      email: `cleanup-${randomUUID()}@example.com`,
      passwordHash: 'test',
    }).returning())[0];
    const createProject = async (userId: number, values: Partial<typeof schema.projects.$inferInsert> = {}) => (
      await db.insert(schema.projects).values({
        userId,
        name: `cleanup-${randomUUID()}`,
        isSaved: true,
        ...values,
      }).returning()
    )[0];
    const createSource = async (userId: number, projectId: number, key: string | null, values: Partial<typeof schema.sourceAssets.$inferInsert> = {}) => (
      await db.insert(schema.sourceAssets).values({
        userId,
        projectId,
        title: `cleanup-${randomUUID()}`,
        assetType: schema.SourceAssetType.UPLOADED_FILE,
        mimeType: 'video/mp4',
        storageKey: key,
        storageUrl: key ? `storage://${key}` : 'storage://no-object',
        status: schema.SourceAssetStatus.UPLOADED,
        ...values,
      }).returning()
    )[0];

    const empty = await POST(authorizedRequest());
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), {
      resumedProjectDeletionCount: 0,
      resumedSourceDeletionCount: 0,
      deletedProjectCount: 0,
      deletedSourceAssetCount: 0,
      deletedRenderedClipCount: 0,
      errorCount: 0,
      staleUploadSessionCount: 0,
    });

    const user = await createUser();
    const pendingProject = await createProject(user.id, { deletionRequestedAt: expiredAt });
    const pendingProjectSource = await createSource(user.id, pendingProject.id, 'pending-project-key');
    const pendingSourceProject = await createProject(user.id);
    const pendingSource = await createSource(user.id, pendingSourceProject.id, 'pending-source-key', {
      deletionRequestedAt: expiredAt,
    });
    const expiredProject = await createProject(user.id, { isSaved: false, expiresAt: expiredAt });
    await createSource(user.id, expiredProject.id, 'project-key', {
      retentionStatus: schema.MediaRetentionStatus.SAVED,
    });
    const sourceProject = await createProject(user.id);
    const expiredSource = await createSource(user.id, sourceProject.id, 'source-key', {
      retentionStatus: schema.MediaRetentionStatus.TEMPORARY,
      expiresAt: expiredAt,
    });
    const clipProject = await createProject(user.id);
    const clipSource = await createSource(user.id, clipProject.id, 'clip-source-key', {
      retentionStatus: schema.MediaRetentionStatus.SAVED,
    });
    const [transcript] = await db.insert(schema.transcripts).values({
      userId: user.id,
      sourceAssetId: clipSource.id,
      content: 'cleanup transcript',
    }).returning();
    const [contentPack] = await db.insert(schema.contentPacks).values({
      userId: user.id,
      projectId: clipProject.id,
      sourceAssetId: clipSource.id,
      name: 'cleanup clip pack',
      generationRunId: randomUUID(),
    }).returning();
    const [candidate] = await db.insert(schema.clipCandidates).values({
      userId: user.id,
      contentPackId: contentPack.id,
      sourceAssetId: clipSource.id,
      transcriptId: transcript.id,
      rank: 1,
      startTimeMs: 0,
      endTimeMs: 1000,
      durationMs: 1000,
      hook: 'hook',
      title: 'title',
      captionCopy: 'caption',
      summary: 'summary',
      transcriptExcerpt: 'excerpt',
      whyItWorks: 'why',
      platformFit: 'fit',
      confidence: 1,
      generationRunId: randomUUID(),
    }).returning();
    const [expiredClip] = await db.insert(schema.renderedClips).values({
      userId: user.id,
      contentPackId: contentPack.id,
      sourceAssetId: clipSource.id,
      clipCandidateId: candidate.id,
      generationRunId: randomUUID(),
      status: schema.RenderedClipStatus.READY,
      title: 'cleanup clip',
      startTimeMs: 0,
      endTimeMs: 1000,
      durationMs: 1000,
      storageKey: 'clip-key',
      retentionStatus: schema.MediaRetentionStatus.TEMPORARY,
      expiresAt: expiredAt,
    }).returning();

    const cleanupResult = await cleanupExpiredTemporaryMedia(now);
    assert.deepEqual(cleanupResult, {
      resumedProjectDeletionCount: 0,
      resumedSourceDeletionCount: 0,
      deletedProjectCount: 0,
      deletedSourceAssetCount: 0,
      deletedRenderedClipCount: 0,
      errorCount: 5,
      errors: [
        'Pending project cleanup failed.',
        'Pending source cleanup failed.',
        'Project cleanup failed.',
        'Source asset cleanup failed.',
        'Rendered clip cleanup failed.',
      ],
    });
    const serializedResult = JSON.stringify(cleanupResult);
    for (const rawFailure of rawFailures.values()) assert.doesNotMatch(serializedResult, new RegExp(rawFailure));
    for (const key of rawFailures.keys()) assert.doesNotMatch(serializedResult, new RegExp(key));
    assert.doesNotMatch(serializedResult, /storage:\/\/|cleanup-|provider body/i);

    const [pendingProjectState, pendingSourceState, expiredSourceState, expiredClipState] = await Promise.all([
      db.query.projects.findFirst({ where: (row, { eq }) => eq(row.id, pendingProject.id) }),
      db.query.sourceAssets.findFirst({ where: (row, { eq }) => eq(row.id, pendingSource.id) }),
      db.query.sourceAssets.findFirst({ where: (row, { eq }) => eq(row.id, expiredSource.id) }),
      db.query.renderedClips.findFirst({ where: (row, { eq }) => eq(row.id, expiredClip.id) }),
    ]);
    assert.ok(pendingProjectState?.deletionRequestedAt);
    assert.ok(pendingSourceState?.deletionRequestedAt);
    assert.equal(expiredSourceState?.retentionStatus, schema.MediaRetentionStatus.TEMPORARY);
    assert.equal(expiredSourceState?.storageDeletedAt, null);
    assert.equal(expiredClipState?.retentionStatus, schema.MediaRetentionStatus.TEMPORARY);
    assert.equal(expiredClipState?.storageDeletedAt, null);
    assert.ok(pendingProjectSource.id > 0);

    const mixedProject = await createProject(user.id);
    const mixedSuccess = await createSource(user.id, mixedProject.id, null, {
      retentionStatus: schema.MediaRetentionStatus.TEMPORARY,
      expiresAt: expiredAt,
    });
    const mixedFailure = await createSource(user.id, mixedProject.id, 'mixed-source-failure-key', {
      retentionStatus: schema.MediaRetentionStatus.TEMPORARY,
      expiresAt: expiredAt,
    });
    const mixedResult = await cleanupExpiredTemporaryMedia(now);
    assert.equal(mixedResult.deletedSourceAssetCount, 1);
    assert.equal(mixedResult.errorCount, 6);
    assert.deepEqual(mixedResult.errors, [
      'Pending project cleanup failed.',
      'Pending project cleanup failed.',
      'Pending source cleanup failed.',
      'Source asset cleanup failed.',
      'Source asset cleanup failed.',
      'Rendered clip cleanup failed.',
    ]);
    const retainedMixedFailure = await db.query.sourceAssets.findFirst({
      where: (row, { eq }) => eq(row.id, mixedFailure.id),
    });
    const removedMixedSuccess = await db.query.sourceAssets.findFirst({
      where: (row, { eq }) => eq(row.id, mixedSuccess.id),
    });
    assert.equal(retainedMixedFailure?.retentionStatus, schema.MediaRetentionStatus.TEMPORARY);
    assert.equal(retainedMixedFailure?.storageDeletedAt, null);
    assert.equal(removedMixedSuccess?.retentionStatus, schema.MediaRetentionStatus.EXPIRED);
    assert.ok(removedMixedSuccess?.storageDeletedAt);

    const partialFailure = await POST(authorizedRequest());
    assert.equal(partialFailure.status, 207);
    const partialFailureJson = await partialFailure.json();
    assert.deepEqual(partialFailureJson, {
      resumedProjectDeletionCount: 0,
      resumedSourceDeletionCount: 0,
      deletedProjectCount: 0,
      deletedSourceAssetCount: 0,
      deletedRenderedClipCount: 0,
      errorCount: 6,
      staleUploadSessionCount: 0,
    });
    assert.doesNotMatch(JSON.stringify(partialFailureJson), /errors|raw |key|storage|provider body/i);

    await appClient.end();
    appClient = undefined;
    const topLevelFailure = await POST(authorizedRequest());
    assert.equal(topLevelFailure.status, 500);
    const topLevelFailureJson = await topLevelFailure.json();
    assert.deepEqual(topLevelFailureJson, { error: 'Failed to clean up expired media.' });
    assert.doesNotMatch(JSON.stringify(topLevelFailureJson), /raw |errors|stack|key|storage|provider body/i);
  } finally {
    globalThis.fetch = originalFetch;
    await appClient?.end();
    await admin.unsafe(`drop schema if exists "${schemaName}" cascade`);
    await admin.end();
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
