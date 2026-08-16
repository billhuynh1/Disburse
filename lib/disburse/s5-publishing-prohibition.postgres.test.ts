import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { register } from 'node:module';
import test from 'node:test';
import postgres from 'postgres';
import type { PipelineProcessingRuntime } from './pipeline-service.ts';
import { assertDisposablePostgresTestDatabase } from '../db/test-database-guard.ts';

register('../test/typescript-path-loader.mjs', import.meta.url);

function extractBalancedBlock(source: string, anchor: string) {
  const anchorIndex = source.indexOf(anchor);
  assert.ok(anchorIndex >= 0, `Missing source anchor: ${anchor}`);

  const start = source.indexOf('{', anchorIndex + anchor.length);
  assert.ok(start >= 0, `Missing block for source anchor: ${anchor}`);

  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
    } else if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
    } else if (character === '"' || character === "'" || character === '`') {
      quote = character;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }

  assert.fail(`Unterminated block for source anchor: ${anchor}`);
}

function normalizeSource(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, '');
}

test('claimed legacy publishing jobs fail closed and recovery preserves requester authorization', {
  skip: !process.env.PHASE1A_TEST_DATABASE_URL,
}, async () => {
  const configuredUrl = process.env.PHASE1A_TEST_DATABASE_URL!;
  assertDisposablePostgresTestDatabase(configuredUrl);

  const schemaName = `s5_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(configuredUrl, { max: 1 });
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  let appClient: { end: () => Promise<void> } | undefined;
  try {
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error('fetch must remain unreachable');
    };
    await admin.unsafe(`create schema "${schemaName}"`);
    await admin.unsafe(`set search_path to "${schemaName}", public`);
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
    isolatedUrl.searchParams.set('application_name', `s5_${schemaName}`);
    process.env.POSTGRES_URL = isolatedUrl.toString();

    const { db, client } = await import('../db/drizzle.ts');
    appClient = client;
    const schema = await import('../db/schema.ts');
    const { eq } = await import('drizzle-orm');
    const { claimNextJob } = await import('./job-service.ts');
    const {
      processClaimedJob,
      productionPipelineProcessingRuntime,
    } = await import('./pipeline-service.ts');
    const {
      buildRecoveryIdempotencyIdentity,
      requestJobRecovery,
    } = await import('./job-recovery-service.ts');
    const {
      DIRECT_PUBLISHING_PROHIBITED_MESSAGE,
    } = await import('./publishing-prohibition.ts');
    const authorizationSource = await readFile(
      new URL('./job-execution-authorization.ts', import.meta.url),
      'utf8'
    );
    const publishingResolver = normalizeSource(extractBalancedBlock(
      authorizationSource,
      'if (job.type === JobType.PUBLISH_RENDERED_CLIP)'
    ));
    assert.match(publishingResolver, /executor\.select\(\{(?=[^}]*id:clipPublications\.id)(?=[^}]*userId:clipPublications\.userId)(?=[^}]*renderedClipId:clipPublications\.renderedClipId)(?=[^}]*linkedAccountId:clipPublications\.linkedAccountId)[^}]*\}\)\.from\(clipPublications\)/);
    assert.match(publishingResolver, /executor\.select\(\{(?=[^}]*id:renderedClips\.id)(?=[^}]*userId:renderedClips\.userId)(?=[^}]*sourceAssetId:renderedClips\.sourceAssetId)(?=[^}]*contentPackId:renderedClips\.contentPackId)[^}]*\}\)\.from\(renderedClips\)/);
    assert.match(publishingResolver, /executor\.select\(\{(?=[^}]*id:linkedAccounts\.id)(?=[^}]*userId:linkedAccounts\.userId)(?=[^}]*platform:linkedAccounts\.platform)[^}]*\}\)\.from\(linkedAccounts\)/);
    assert.doesNotMatch(publishingResolver, /\b(?:accessToken|refreshToken)\b/);
    assert.doesNotMatch(publishingResolver, /\.select\(\)\.from\(linkedAccounts\)/);
    const authorizeStart = authorizationSource.indexOf('async function authorize(');
    const authorizeEnd = authorizationSource.indexOf(
      'async function authorizeMissingCandidateCancellation(',
      authorizeStart
    );
    assert.ok(authorizeStart >= 0);
    assert.ok(authorizeEnd > authorizeStart);
    const authorizeSource = authorizationSource.slice(authorizeStart, authorizeEnd);
    assert.ok(authorizeSource.includes('const initial = await resolveResources(executor, initialJob)'));
    assert.ok(authorizeSource.includes('const resources = await resolveResources(executor, job)'));

    const [owner] = await db.insert(schema.users).values({
      email: `s5-owner-${randomUUID()}@example.com`,
      passwordHash: 'test',
    }).returning();
    const [otherUser] = await db.insert(schema.users).values({
      email: `s5-other-${randomUUID()}@example.com`,
      passwordHash: 'test',
    }).returning();
    const [relationshipUser] = await db.insert(schema.users).values({
      email: `s5-relationship-${randomUUID()}@example.com`,
      passwordHash: 'test',
    }).returning();
    const [project] = await db.insert(schema.projects).values({
      userId: owner.id,
      name: 'S5 publishing fixture',
      isSaved: true,
    }).returning();
    const [source] = await db.insert(schema.sourceAssets).values({
      userId: owner.id,
      projectId: project.id,
      title: 'S5 source',
      assetType: schema.SourceAssetType.UPLOADED_FILE,
      originalFilename: 's5.mp4',
      mimeType: 'video/mp4',
      storageKey: `s5-${randomUUID()}.mp4`,
      storageUrl: 'storage://s5.mp4',
      status: schema.SourceAssetStatus.READY,
    }).returning();
    const [transcript] = await db.insert(schema.transcripts).values({
      userId: owner.id,
      sourceAssetId: source.id,
      content: 'S5 transcript.',
      status: schema.TranscriptStatus.READY,
    }).returning();
    const generationRunId = randomUUID();
    const [pack] = await db.insert(schema.contentPacks).values({
      userId: owner.id,
      projectId: project.id,
      sourceAssetId: source.id,
      transcriptId: transcript.id,
      kind: schema.ContentPackKind.SHORT_FORM_CLIPS,
      name: 'S5 pack',
      generationRunId,
      status: schema.ContentPackStatus.READY,
    }).returning();
    const [candidate] = await db.insert(schema.clipCandidates).values({
      userId: owner.id,
      contentPackId: pack.id,
      sourceAssetId: source.id,
      transcriptId: transcript.id,
      rank: 1,
      startTimeMs: 0,
      endTimeMs: 30_000,
      durationMs: 30_000,
      hook: 'S5 hook',
      title: 'S5 candidate',
      captionCopy: 'S5 caption',
      summary: 'S5 summary',
      transcriptExcerpt: 'S5 transcript.',
      whyItWorks: 'S5 proof',
      platformFit: 'Short-form video',
      confidence: 90,
      generationRunId,
    }).returning();
    const [clip] = await db.insert(schema.renderedClips).values({
      userId: owner.id,
      contentPackId: pack.id,
      sourceAssetId: source.id,
      clipCandidateId: candidate.id,
      generationRunId,
      variant: schema.RenderedClipVariant.TRIMMED_ORIGINAL,
      layout: schema.RenderedClipLayout.DEFAULT,
      status: schema.RenderedClipStatus.READY,
      title: 'S5 rendered clip',
      startTimeMs: 0,
      endTimeMs: 30_000,
      durationMs: 30_000,
      storageKey: `s5-rendered-${randomUUID()}.mp4`,
      storageUrl: 'storage://s5-rendered.mp4',
      mimeType: 'video/mp4',
    }).returning();
    const [account] = await db.insert(schema.linkedAccounts).values({
      userId: owner.id,
      platform: 'youtube',
      platformAccountId: `s5-${randomUUID()}`,
      accessToken: 'fake-access-token',
    }).returning();
    const [publication] = await db.insert(schema.clipPublications).values({
      userId: owner.id,
      renderedClipId: clip.id,
      linkedAccountId: account.id,
      platform: 'youtube',
      status: schema.ClipPublicationStatus.PUBLISHING,
      platformPostId: 'unchanged-post-id',
      platformUrl: 'https://invalid.test/unchanged',
    }).returning();
    const [queued] = await db.insert(schema.jobs).values({
      type: schema.JobType.PUBLISH_RENDERED_CLIP,
      status: schema.JobStatus.PENDING,
      idempotencyKey: `s5-publish-${randomUUID()}`,
      logicalJobKey: `s5-publish-${randomUUID()}`,
      payload: {
        clipPublicationId: publication.id,
        renderedClipId: clip.id,
        linkedAccountId: account.id,
        userId: owner.id,
        platform: 'youtube',
      },
    }).returning();
    const claimed = await claimNextJob();
    assert.ok(claimed);
    assert.equal(claimed.id, queued.id);

    let providerCalls = 0;
    const runtime: PipelineProcessingRuntime = {
      ...productionPipelineProcessingRuntime,
      processors: {
        ...productionPipelineProcessingRuntime.processors,
        publishClip: async () => {
          providerCalls += 1;
          throw new Error('provider adapter must remain unreachable');
        },
      },
      downstream: { trigger: () => undefined },
      timer: { startHeartbeat: () => null, stopHeartbeat: () => undefined },
    };
    const result = await processClaimedJob(claimed, runtime);
    assert.equal(result.status, 'failed');
    assert.equal(providerCalls, 0);
    const [failedJob] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, queued.id));
    const [failedPublication] = await db.select()
      .from(schema.clipPublications)
      .where(eq(schema.clipPublications.id, publication.id));
    const checkpoints = await db.select().from(schema.jobEffectCheckpoints)
      .where(eq(schema.jobEffectCheckpoints.jobId, queued.id));
    assert.ok(failedJob);
    assert.ok(failedPublication);
    assert.equal(failedJob.status, schema.JobStatus.FAILED);
    assert.equal(failedJob.failureCode, 'direct_publishing_prohibited');
    assert.equal(failedJob.failureClass, schema.JobFailureClass.PERMANENT);
    assert.equal(failedJob.failureReason, DIRECT_PUBLISHING_PROHIBITED_MESSAGE);
    assert.equal(failedPublication.status, schema.ClipPublicationStatus.FAILED);
    assert.equal(failedPublication.failureReason, DIRECT_PUBLISHING_PROHIBITED_MESSAGE);
    assert.equal(failedPublication.platformPostId, 'unchanged-post-id');
    assert.equal(failedPublication.platformUrl, 'https://invalid.test/unchanged');
    assert.equal(checkpoints.length, 0);

    const replay = await processClaimedJob(claimed, runtime);
    assert.equal(replay.status, 'lease_lost');
    assert.equal(providerCalls, 0);
    const [replayedJob] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, queued.id));
    const [replayedPublication] = await db.select()
      .from(schema.clipPublications)
      .where(eq(schema.clipPublications.id, publication.id));
    assert.ok(replayedJob);
    assert.ok(replayedPublication);
    assert.equal(replayedJob.status, schema.JobStatus.FAILED);
    assert.equal(replayedPublication.status, schema.ClipPublicationStatus.FAILED);
    assert.equal(fetchCalls, 0);
    const failureNotifications = await db.select().from(schema.notifications).where(
      eq(
        schema.notifications.dedupeKey,
        `clip_publication:${publication.id}:failure:publication:${publication.id}:failed`
      )
    );
    assert.equal(failureNotifications.length, 1);
    assert.equal(failureNotifications[0]?.userId, owner.id);
    assert.equal(failureNotifications[0]?.type, schema.NotificationType.CLIP_PUBLICATION);
    assert.equal(failureNotifications[0]?.entityType, 'clip_publication');
    assert.equal(failureNotifications[0]?.entityId, publication.id);
    assert.equal(
      failureNotifications[0]?.dedupeKey,
      `clip_publication:${publication.id}:failure:publication:${publication.id}:failed`
    );

    const ownerRequest = {
      userId: owner.id,
      jobId: queued.id,
      mode: schema.JobRecoveryMode.RETRY,
      idempotencyKey: `s5-owner-${randomUUID()}`,
      requestedBy: 'user' as const,
    };
    const ownerResult = await requestJobRecovery(ownerRequest);
    const ownerReplay = await requestJobRecovery(ownerRequest);
    const nonOwnerResult = await requestJobRecovery({
      ...ownerRequest,
      userId: otherUser.id,
      idempotencyKey: `s5-other-${randomUUID()}`,
    });
    await db.update(schema.users).set({ deletedAt: new Date() })
      .where(eq(schema.users.id, otherUser.id));
    const missingUserResult = await requestJobRecovery({
      ...ownerRequest,
      userId: otherUser.id,
      idempotencyKey: `s5-missing-${randomUUID()}`,
    });
    assert.equal(ownerResult.code, 'publishing_recovery_forbidden');
    assert.deepEqual(ownerReplay, ownerResult);
    assert.equal(nonOwnerResult.code, 'forbidden');
    assert.equal(missingUserResult.code, 'user_missing');
    assert.equal(ownerResult.successorJobId, null);
    assert.equal(nonOwnerResult.successorJobId, null);
    assert.equal(missingUserResult.successorJobId, null);
    const ownerIdentity = buildRecoveryIdempotencyIdentity(ownerRequest.idempotencyKey);
    const recoveryRequests = await db.select().from(schema.jobRecoveryRequests).where(
      eq(schema.jobRecoveryRequests.idempotencyIdentity, ownerIdentity)
    );
    assert.equal(recoveryRequests.length, 1);
    assert.equal(recoveryRequests[0]?.outcomeCode, 'publishing_recovery_forbidden');
    const recoveryEvents = await db.select().from(schema.jobRecoveryEvents).where(
      eq(schema.jobRecoveryEvents.requestIdentity, ownerIdentity)
    );
    assert.equal(
      recoveryEvents.filter((event) => event.eventType === 'duplicate').length,
      1
    );

    const createRecoveryPublishingJob = async (payload: {
      clipPublicationId: number;
      renderedClipId: number;
      linkedAccountId: number;
      userId: number;
      platform: 'youtube' | 'tiktok';
    }) => {
      const [job] = await db.insert(schema.jobs).values({
        type: schema.JobType.PUBLISH_RENDERED_CLIP,
        status: schema.JobStatus.FAILED,
        idempotencyKey: `s5-recovery-${randomUUID()}`,
        logicalJobKey: `s5-recovery-${randomUUID()}`,
        payload,
      }).returning();
      return job;
    };
    const requestRecovery = async (jobId: number) => await requestJobRecovery({
      userId: owner.id,
      jobId,
      mode: schema.JobRecoveryMode.RETRY,
      idempotencyKey: `s5-relationship-${randomUUID()}`,
      requestedBy: 'user' as const,
    });

    const [foreignPublicationAccount] = await db.insert(schema.linkedAccounts).values({
      userId: relationshipUser.id,
      platform: 'youtube',
      platformAccountId: `s5-foreign-publication-${randomUUID()}`,
      accessToken: 'fake-foreign-publication-access-token',
    }).returning();
    const [foreignPublication] = await db.insert(schema.clipPublications).values({
      userId: relationshipUser.id,
      renderedClipId: clip.id,
      linkedAccountId: foreignPublicationAccount.id,
      platform: 'youtube',
      status: schema.ClipPublicationStatus.FAILED,
    }).returning();
    const foreignPublicationJob = await createRecoveryPublishingJob({
      clipPublicationId: foreignPublication.id,
      renderedClipId: clip.id,
      linkedAccountId: foreignPublicationAccount.id,
      userId: owner.id,
      platform: 'youtube',
    });
    const foreignPublicationResult = await requestRecovery(foreignPublicationJob.id);
    assert.equal(foreignPublicationResult.code, 'relationship_mismatch');
    assert.notEqual(foreignPublicationResult.code, 'publishing_recovery_forbidden');
    assert.equal(foreignPublicationResult.successorJobId, null);

    const [foreignAccount] = await db.insert(schema.linkedAccounts).values({
      userId: relationshipUser.id,
      platform: 'youtube',
      platformAccountId: `s5-foreign-${randomUUID()}`,
      accessToken: 'fake-foreign-access-token',
    }).returning();
    const [foreignAccountPublication] = await db.insert(schema.clipPublications).values({
      userId: owner.id,
      renderedClipId: clip.id,
      linkedAccountId: foreignAccount.id,
      platform: 'youtube',
      status: schema.ClipPublicationStatus.FAILED,
    }).returning();
    const foreignAccountJob = await createRecoveryPublishingJob({
      clipPublicationId: foreignAccountPublication.id,
      renderedClipId: clip.id,
      linkedAccountId: foreignAccount.id,
      userId: owner.id,
      platform: 'youtube',
    });
    const foreignAccountResult = await requestRecovery(foreignAccountJob.id);
    assert.equal(foreignAccountResult.code, 'relationship_mismatch');
    assert.notEqual(foreignAccountResult.code, 'publishing_recovery_forbidden');
    assert.equal(foreignAccountResult.successorJobId, null);

    const [unrelatedCandidate] = await db.insert(schema.clipCandidates).values({
      userId: owner.id,
      contentPackId: pack.id,
      sourceAssetId: source.id,
      transcriptId: transcript.id,
      rank: 2,
      startTimeMs: 30_000,
      endTimeMs: 60_000,
      durationMs: 30_000,
      hook: 'Unrelated hook',
      title: 'Unrelated candidate',
      captionCopy: 'Unrelated caption',
      summary: 'Unrelated summary',
      transcriptExcerpt: 'S5 transcript.',
      whyItWorks: 'Fixture evidence',
      platformFit: 'Short-form video',
      confidence: 80,
      generationRunId,
    }).returning();
    const [unrelatedClip] = await db.insert(schema.renderedClips).values({
      userId: owner.id,
      contentPackId: pack.id,
      sourceAssetId: source.id,
      clipCandidateId: unrelatedCandidate.id,
      generationRunId,
      variant: schema.RenderedClipVariant.TRIMMED_ORIGINAL,
      layout: schema.RenderedClipLayout.DEFAULT,
      status: schema.RenderedClipStatus.READY,
      title: 'Unrelated rendered clip',
      startTimeMs: 30_000,
      endTimeMs: 60_000,
      durationMs: 30_000,
      storageKey: `s5-unrelated-${randomUUID()}.mp4`,
      storageUrl: 'storage://s5-unrelated.mp4',
      mimeType: 'video/mp4',
    }).returning();
    const unrelatedClipJob = await createRecoveryPublishingJob({
      clipPublicationId: publication.id,
      renderedClipId: unrelatedClip.id,
      linkedAccountId: account.id,
      userId: owner.id,
      platform: 'youtube',
    });
    const unrelatedClipResult = await requestRecovery(unrelatedClipJob.id);
    assert.equal(unrelatedClipResult.code, 'relationship_mismatch');
    assert.notEqual(unrelatedClipResult.code, 'publishing_recovery_forbidden');
    assert.equal(unrelatedClipResult.successorJobId, null);
    const [unchangedPublication] = await db.select().from(schema.clipPublications).where(
      eq(schema.clipPublications.id, publication.id)
    );
    const [unchangedUnrelatedJob] = await db.select().from(schema.jobs).where(
      eq(schema.jobs.id, unrelatedClipJob.id)
    );
    assert.equal(unchangedPublication?.status, schema.ClipPublicationStatus.FAILED);
    assert.equal(unchangedUnrelatedJob?.status, schema.JobStatus.FAILED);

    const missingPublicationJob = await createRecoveryPublishingJob({
      clipPublicationId: publication.id + 10_000_000,
      renderedClipId: clip.id,
      linkedAccountId: account.id,
      userId: owner.id,
      platform: 'youtube',
    });
    const missingClipJob = await createRecoveryPublishingJob({
      clipPublicationId: publication.id,
      renderedClipId: clip.id + 10_000_000,
      linkedAccountId: account.id,
      userId: owner.id,
      platform: 'youtube',
    });
    const missingAccountJob = await createRecoveryPublishingJob({
      clipPublicationId: publication.id,
      renderedClipId: clip.id,
      linkedAccountId: account.id + 10_000_000,
      userId: owner.id,
      platform: 'youtube',
    });
    for (const job of [missingPublicationJob, missingClipJob, missingAccountJob]) {
      const result = await requestRecovery(job.id);
      assert.equal(result.code, 'related_record_missing');
      assert.notEqual(result.code, 'publishing_recovery_forbidden');
      assert.equal(result.successorJobId, null);
    }

    const publishingJobs = await db.select().from(schema.jobs)
      .where(eq(schema.jobs.type, schema.JobType.PUBLISH_RENDERED_CLIP));
    assert.equal(publishingJobs.length, 7);
  } finally {
    globalThis.fetch = originalFetch;
    if (appClient) await appClient.end();
    await admin.unsafe(`drop schema if exists "${schemaName}" cascade`);
    await admin.end();
  }
});
