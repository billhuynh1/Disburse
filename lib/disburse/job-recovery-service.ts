import 'server-only';

import { createHash, randomUUID } from 'node:crypto';

import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '@/lib/db/drizzle';
import {
  clipCandidateFacecamDetectionRuns,
  clipCandidates,
  clipRenderConfigs,
  contentPacks,
  JobFailureClass,
  JobRecoveryMode,
  JobRecoveryOutcome,
  JobStatus,
  JobType,
  jobRecoveryEvents,
  jobRecoveryRequests,
  jobs,
  projects,
  renderedClips,
  ReusableAssetKind,
  reusableAssets,
  sourceAssets,
  users,
  type Job,
} from '@/lib/db/schema';
import { getCompletedCheckpointForJob } from '@/lib/disburse/job-effect-checkpoint-service';
import { parseJobPayloadForType } from '@/lib/disburse/job-payload-schema';
import { isMediaUnavailable } from '@/lib/disburse/media-retention-service';

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const MAX_LINEAGE_RECOVERY_ATTEMPTS = 3;
const VALID_IDEMPOTENCY_KEY_MAX = 200;
const VALID_IDEMPOTENCY_DOMAIN = 'recovery-id:v1:valid';
const MALFORMED_IDEMPOTENCY_DOMAIN = 'recovery-id:v1:malformed';
const REQUEST_FINGERPRINT_DOMAIN = 'disburse:job-recovery:request:v1';

export const recoveryRequestSchema = z.object({
  userId: z.number().int().positive(),
  jobId: z.number().int().positive(),
  mode: z.nativeEnum(JobRecoveryMode),
  idempotencyKey: z.string().trim().min(1).max(VALID_IDEMPOTENCY_KEY_MAX),
  expectedCurrentGeneration: z.string().trim().min(1).max(200).optional(),
  requestedBy: z.enum(['user', 'operator']).default('user'),
}).strict();

export type RecoveryRequestInput = z.infer<typeof recoveryRequestSchema>;
export type RecoveryResult = {
  outcome: JobRecoveryOutcome;
  code: string;
  successorJobId: number | null;
  requestedJobId: number | null;
  canonical: boolean;
};

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export function buildRecoveryIdempotencyIdentity(value: unknown) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0 && trimmed.length <= VALID_IDEMPOTENCY_KEY_MAX) {
      return `${VALID_IDEMPOTENCY_DOMAIN}:${sha256(trimmed)}`;
    }
    return `${MALFORMED_IDEMPOTENCY_DOMAIN}:${Array.from(value).length}:${Buffer.byteLength(value, 'utf8')}:${sha256(value)}`;
  }
  const tagged = `${typeof value}:${String(value)}`;
  return `${MALFORMED_IDEMPOTENCY_DOMAIN}:${Array.from(tagged).length}:${Buffer.byteLength(tagged, 'utf8')}:${sha256(tagged)}`;
}

function buildFingerprint(input: {
  requestKind: 'valid' | 'invalid';
  userId: number | null;
  jobId: number | null;
  mode: string | null;
  expectedCurrentGeneration: string | null;
  idempotencyIdentity: string;
  requestedBy?: 'user' | 'operator';
  invalidCode?: string;
  safeMetadata?: Record<string, string | number | boolean | null>;
}) {
  return sha256(`${REQUEST_FINGERPRINT_DOMAIN}\n${JSON.stringify(input)}`);
}

function isCanonicalReplay(
  existing: typeof jobRecoveryRequests.$inferSelect,
  request: {
    fingerprint: string;
    userId: number | null;
    jobId: number | null;
    mode: string | null;
    expectedCurrentGeneration: string | null;
  }
) {
  return existing.requestFingerprint === request.fingerprint
    && existing.requestedUserId === request.userId
    && existing.requestedJobId === request.jobId
    && existing.requestedMode === request.mode
    && existing.expectedCurrentGeneration === request.expectedCurrentGeneration;
}

function idempotencyConflictResult(): RecoveryResult {
  return {
    outcome: JobRecoveryOutcome.REJECTED,
    code: 'idempotency_conflict',
    successorJobId: null,
    requestedJobId: null,
    canonical: false,
  };
}

function toResult(row: typeof jobRecoveryRequests.$inferSelect): RecoveryResult {
  return {
    outcome: row.outcome as JobRecoveryOutcome,
    code: row.outcomeCode,
    successorJobId: row.successorJobId,
    requestedJobId: row.requestedJobId,
    canonical: true,
  };
}

async function lockRequestIdentity(tx: DbTransaction, identity: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${identity}, 0))`);
}

async function recordEvent(
  tx: DbTransaction,
  identity: string,
  requestedJobId: number | null,
  eventType: string,
  outcomeCode: string,
  safeMetadata: Record<string, string | number | boolean | null> = {}
) {
  await tx.insert(jobRecoveryEvents).values({
    requestIdentity: identity,
    requestedJobId,
    eventType,
    outcomeCode,
    safeMetadata,
  });
}

async function insertRejected(
  tx: DbTransaction,
  params: {
    identity: string;
    fingerprint: string;
    userId: number | null;
    jobId: number | null;
    mode: string | null;
    expectedCurrentGeneration: string | null;
    code: string;
    safeMetadata?: Record<string, string | number | boolean | null>;
  }
) {
  const [row] = await tx.insert(jobRecoveryRequests).values({
    idempotencyIdentity: params.identity,
    requestFingerprint: params.fingerprint,
    requestedUserId: params.userId,
    requestedJobId: params.jobId,
    requestedMode: params.mode,
    expectedCurrentGeneration: params.expectedCurrentGeneration,
    outcome: JobRecoveryOutcome.REJECTED,
    outcomeCode: params.code,
    successorJobId: null,
    safeMetadata: params.safeMetadata ?? {},
  }).returning();
  await recordEvent(tx, params.identity, params.jobId, 'rejected', params.code);
  return toResult(row);
}

export async function persistInvalidRecoveryRequest(params: {
  idempotencyKey: unknown;
  userId?: number | null;
  jobId?: number | null;
  mode?: string | null;
  expectedCurrentGeneration?: string | null;
  code: string;
  safeMetadata?: Record<string, string | number | boolean | null>;
}) {
  const identity = buildRecoveryIdempotencyIdentity(params.idempotencyKey);
  const fingerprint = buildFingerprint({
    requestKind: 'invalid',
    userId: params.userId ?? null,
    jobId: params.jobId ?? null,
    mode: params.mode ?? null,
    expectedCurrentGeneration: params.expectedCurrentGeneration ?? null,
    idempotencyIdentity: identity,
    invalidCode: params.code,
    safeMetadata: params.safeMetadata ?? {},
  });
  const canonicalRequest = {
    fingerprint,
    userId: params.userId ?? null,
    jobId: params.jobId ?? null,
    mode: params.mode ?? null,
    expectedCurrentGeneration: params.expectedCurrentGeneration ?? null,
  };
  return await db.transaction(async (tx) => {
    await lockRequestIdentity(tx, identity);
    const existing = await tx.query.jobRecoveryRequests.findFirst({
      where: eq(jobRecoveryRequests.idempotencyIdentity, identity),
    });
    if (existing) {
      if (!isCanonicalReplay(existing, canonicalRequest)) {
        await recordEvent(tx, identity, null, 'conflict', 'idempotency_conflict');
        return idempotencyConflictResult();
      }
      await recordEvent(tx, identity, existing.requestedJobId, 'duplicate', existing.outcomeCode);
      return toResult(existing);
    }
    return await insertRejected(tx, {
      identity,
      fingerprint,
      userId: params.userId ?? null,
      jobId: params.jobId ?? null,
      mode: params.mode ?? null,
      expectedCurrentGeneration: params.expectedCurrentGeneration ?? null,
      code: params.code,
      safeMetadata: params.safeMetadata,
    });
  });
}

function rootId(job: Job) {
  return job.rootJobId ?? job.id;
}

async function lockLatestLineageLeaf(tx: DbTransaction, requested: Job) {
  const root = rootId(requested);
  const lineage = await tx.select().from(jobs).where(
    or(eq(jobs.id, root), eq(jobs.rootJobId, root))
  ).orderBy(jobs.recoveryAttempt, jobs.id).for('update');
  return lineage.at(-1) ?? requested;
}

async function findLatestLineageLeaf(requested: Job) {
  const root = rootId(requested);
  const lineage = await db.select().from(jobs).where(
    or(eq(jobs.id, root), eq(jobs.rootJobId, root))
  ).orderBy(jobs.recoveryAttempt, jobs.id);
  return lineage.at(-1) ?? requested;
}

async function rejectLocked(
  tx: DbTransaction,
  common: {
    identity: string;
    fingerprint: string;
    userId: number;
    jobId: number;
    mode: JobRecoveryMode;
    expectedCurrentGeneration: string | null;
  },
  code: string
) {
  return await insertRejected(tx, { ...common, code });
}

async function lockAndValidateLifecycle(
  tx: DbTransaction,
  job: Job,
  userId: number
) {
  if (!Object.values(JobType).includes(job.type as JobType)) return { code: 'invalid_job_type' as const };
  const payload = parseJobPayloadForType(job.type, job.payload) as Record<string, unknown> | null;
  if (!payload) return { code: 'invalid_payload' as const };
  if (payload.userId !== userId) return { code: 'forbidden' as const };
  if (job.type === JobType.PUBLISH_RENDERED_CLIP) return { code: 'publishing_recovery_forbidden' as const };
  const sourceAssetId = payload.sourceAssetId as number | undefined;
  if (!sourceAssetId) return { code: 'invalid_payload' as const };

  const sourceRef = await tx.query.sourceAssets.findFirst({
    where: eq(sourceAssets.id, sourceAssetId),
    columns: { projectId: true },
  });
  if (!sourceRef) return { code: 'source_asset_missing' as const };
  const [project] = await tx.select().from(projects).where(eq(projects.id, sourceRef.projectId)).for('update').limit(1);
  if (!project || project.userId !== userId) return { code: 'forbidden' as const };
  const [source] = await tx.select().from(sourceAssets).where(eq(sourceAssets.id, sourceAssetId)).for('update').limit(1);
  if (!source || source.userId !== userId || source.projectId !== project.id) return { code: 'relationship_mismatch' as const };
  if (project.deletionRequestedAt || source.deletionRequestedAt) return { code: 'deletion_in_progress' as const };
  if (isMediaUnavailable(source)) return { code: 'media_unavailable' as const };

  const contentPackId = typeof payload.contentPackId === 'number' ? payload.contentPackId : null;
  const [pack] = contentPackId
    ? await tx.select().from(contentPacks).where(eq(contentPacks.id, contentPackId)).for('update').limit(1)
    : [null];
  if (contentPackId && !pack) return { code: 'related_record_missing' as const };
  if (pack && (pack.userId !== userId || pack.projectId !== project.id || pack.sourceAssetId !== source.id)) {
    return { code: 'relationship_mismatch' as const };
  }
  const generationRunId = typeof payload.generationRunId === 'string' ? payload.generationRunId : null;
  if (pack && generationRunId && pack.generationRunId !== generationRunId) {
    return { code: 'generation_superseded' as const };
  }

  const clipCandidateId = typeof payload.clipCandidateId === 'number' ? payload.clipCandidateId : null;
  if (clipCandidateId) {
    const [candidate] = await tx.select().from(clipCandidates).where(eq(clipCandidates.id, clipCandidateId)).for('update').limit(1);
    if (!candidate) return { code: 'related_record_missing' as const };
    if (candidate.userId !== userId || candidate.sourceAssetId !== source.id || candidate.contentPackId !== pack?.id || candidate.generationRunId !== generationRunId) {
      return { code: 'relationship_mismatch' as const };
    }
  }
  const renderConfigId = typeof payload.renderConfigId === 'number' ? payload.renderConfigId : null;
  if (renderConfigId) {
    const [renderConfig] = await tx.select().from(clipRenderConfigs).where(eq(clipRenderConfigs.id, renderConfigId)).for('update').limit(1);
    if (!renderConfig || renderConfig.userId !== userId || renderConfig.sourceAssetId !== source.id || renderConfig.contentPackId !== pack?.id || renderConfig.clipCandidateId !== clipCandidateId || renderConfig.generationRunId !== generationRunId) {
      return { code: 'relationship_mismatch' as const };
    }
  }
  const detectionRunId = typeof payload.detectionRunId === 'number' ? payload.detectionRunId : null;
  if (detectionRunId) {
    const [run] = await tx.select().from(clipCandidateFacecamDetectionRuns).where(eq(clipCandidateFacecamDetectionRuns.id, detectionRunId)).for('update').limit(1);
    if (!run || run.userId !== userId || run.sourceAssetId !== source.id || run.contentPackId !== pack?.id || run.clipCandidateId !== clipCandidateId || run.generationRunId !== generationRunId) {
      return { code: 'relationship_mismatch' as const };
    }
  }
  const renderedClipId = typeof payload.renderedClipId === 'number' ? payload.renderedClipId : null;
  if (renderedClipId) {
    const [clip] = await tx.select().from(renderedClips).where(eq(renderedClips.id, renderedClipId)).for('update').limit(1);
    if (!clip || clip.userId !== userId || clip.sourceAssetId !== source.id || clip.contentPackId !== pack?.id) {
      return { code: 'relationship_mismatch' as const };
    }
  }
  const captionFontAssetId = typeof payload.captionFontAssetId === 'number' ? payload.captionFontAssetId : null;
  if (captionFontAssetId) {
    const [font] = await tx.select().from(reusableAssets).where(eq(reusableAssets.id, captionFontAssetId)).for('update').limit(1);
    if (!font || font.userId !== userId || font.kind !== ReusableAssetKind.FONT) {
      return { code: 'caption_font_invalid' as const };
    }
  }
  return { payload, project, source, pack };
}

export async function requestJobRecovery(rawInput: RecoveryRequestInput): Promise<RecoveryResult> {
  const parsed = recoveryRequestSchema.safeParse(rawInput);
  if (!parsed.success) {
    return await persistInvalidRecoveryRequest({
      idempotencyKey: (rawInput as { idempotencyKey?: unknown })?.idempotencyKey,
      userId: (rawInput as { userId?: number })?.userId,
      jobId: (rawInput as { jobId?: number })?.jobId,
      mode: (rawInput as { mode?: string })?.mode,
      expectedCurrentGeneration: (rawInput as { expectedCurrentGeneration?: string })?.expectedCurrentGeneration,
      code: 'invalid_request',
    });
  }
  const input = parsed.data;
  const identity = buildRecoveryIdempotencyIdentity(input.idempotencyKey);
  const common = {
    identity,
    fingerprint: buildFingerprint({
      requestKind: 'valid',
      userId: input.userId,
      jobId: input.jobId,
      mode: input.mode,
      expectedCurrentGeneration: input.expectedCurrentGeneration ?? null,
      idempotencyIdentity: identity,
      requestedBy: input.requestedBy,
    }),
    userId: input.userId,
    jobId: input.jobId,
    mode: input.mode,
    expectedCurrentGeneration: input.expectedCurrentGeneration ?? null,
  };

  try {
    return await db.transaction(async (tx) => {
      await lockRequestIdentity(tx, identity);
      const existing = await tx.query.jobRecoveryRequests.findFirst({
        where: eq(jobRecoveryRequests.idempotencyIdentity, identity),
      });
      if (existing) {
        if (!isCanonicalReplay(existing, common)) {
          await recordEvent(tx, identity, null, 'conflict', 'idempotency_conflict');
          return idempotencyConflictResult();
        }
        await recordEvent(tx, identity, existing.requestedJobId, 'duplicate', existing.outcomeCode);
        return toResult(existing);
      }

      const requested = await tx.query.jobs.findFirst({ where: eq(jobs.id, input.jobId) });
      if (!requested) return await rejectLocked(tx, common, 'job_missing');
      const requestingUser = await tx.query.users.findFirst({ where: eq(users.id, input.userId) });
      if (!requestingUser || requestingUser.deletedAt) {
        return await rejectLocked(tx, common, 'user_missing');
      }
      const expectedLeaf = await findLatestLineageLeaf(requested);
      const lifecycle = await lockAndValidateLifecycle(tx, expectedLeaf, input.userId);
      if ('code' in lifecycle && lifecycle.code) {
        return await rejectLocked(tx, common, lifecycle.code);
      }
      const leaf = await lockLatestLineageLeaf(tx, requested);
      if (leaf.id !== expectedLeaf.id) {
        return await rejectLocked(tx, common, 'lineage_changed');
      }
      if (![JobStatus.FAILED, JobStatus.CANCELLED].includes(leaf.status as JobStatus)) {
        return await rejectLocked(tx, common, 'latest_lineage_job_not_terminal');
      }
      if (leaf.recoveryAttempt >= MAX_LINEAGE_RECOVERY_ATTEMPTS) {
        return await rejectLocked(tx, common, 'lineage_attempts_exhausted');
      }

      if (input.mode === JobRecoveryMode.RETRY && leaf.failureClass !== JobFailureClass.SAFE_NO_EXTERNAL_EFFECT) {
        return await rejectLocked(tx, common, 'retry_not_proven_safe');
      }
      if (input.mode === JobRecoveryMode.RESUME) {
        const checkpoint = await getCompletedCheckpointForJob(leaf.id, leaf.type as JobType);
        if (!checkpoint) return await rejectLocked(tx, common, 'resume_checkpoint_missing');
      }
      if (input.mode === JobRecoveryMode.NEW_GENERATION) {
        if (leaf.type !== JobType.GENERATE_SHORT_FORM_PACK || !lifecycle.pack) {
          return await rejectLocked(tx, common, 'new_generation_not_supported');
        }
        if (!input.expectedCurrentGeneration || lifecycle.pack.generationRunId !== input.expectedCurrentGeneration) {
          return await rejectLocked(tx, common, 'expected_generation_mismatch');
        }
      }

      const root = rootId(requested);
      const logicalJobKey = `recovery:${root}`;
      const active = await tx.query.jobs.findFirst({
        where: and(eq(jobs.logicalJobKey, logicalJobKey), inArray(jobs.status, [JobStatus.PENDING, JobStatus.PROCESSING])),
      });
      if (active) return await rejectLocked(tx, common, 'active_successor_exists');

      let payload = { ...(leaf.payload as Record<string, unknown>) };
      if (input.mode === JobRecoveryMode.NEW_GENERATION) {
        const nextGeneration = randomUUID();
        payload = { ...payload, generationRunId: nextGeneration };
        await tx.update(contentPacks).set({
          generationRunId: nextGeneration,
          status: 'pending',
          failureReason: null,
          updatedAt: new Date(),
        }).where(and(
          eq(contentPacks.id, lifecycle.pack!.id),
          eq(contentPacks.generationRunId, input.expectedCurrentGeneration!)
        ));
        await tx.update(jobs).set({
          status: JobStatus.CANCELLED,
          completedAt: new Date(),
          cancellationReason: 'generation_superseded',
          cancellationRequestedAt: new Date(),
          failureReason: 'Generation superseded.',
          failureCode: 'generation_superseded',
          failureClass: JobFailureClass.CANCELLED,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        }).where(and(
          inArray(jobs.status, [JobStatus.PENDING, JobStatus.PROCESSING]),
          sql<boolean>`${jobs.payload}->>'contentPackId' = ${String(lifecycle.pack!.id)}`,
          sql<boolean>`coalesce(${jobs.payload}->>'generationRunId', '') <> ${nextGeneration}`
        ));
      }

      const [successor] = await tx.insert(jobs).values({
        type: leaf.type,
        status: JobStatus.PENDING,
        idempotencyKey: `recovery:${sha256(identity)}`,
        payload: payload as Job['payload'],
        attemptCount: 0,
        maxAttempts: leaf.maxAttempts,
        logicalJobKey,
        rootJobId: root,
        parentJobId: leaf.id,
        recoveryAttempt: leaf.recoveryAttempt + 1,
        recoveryMode: input.mode,
      }).returning();
      const [request] = await tx.insert(jobRecoveryRequests).values({
        idempotencyIdentity: identity,
        requestFingerprint: common.fingerprint,
        requestedUserId: input.userId,
        requestedJobId: input.jobId,
        requestedMode: input.mode,
        expectedCurrentGeneration: input.expectedCurrentGeneration ?? null,
        outcome: JobRecoveryOutcome.ACCEPTED,
        outcomeCode: 'successor_created',
        successorJobId: successor.id,
        safeMetadata: { requestedBy: input.requestedBy },
      }).returning();
      await recordEvent(tx, identity, input.jobId, 'accepted', 'successor_created', {
        successorJobId: successor.id,
      });
      return toResult(request);
    });
  } catch {
    return await persistInvalidRecoveryRequest({
      idempotencyKey: input.idempotencyKey,
      userId: input.userId,
      jobId: input.jobId,
      mode: input.mode,
      expectedCurrentGeneration: input.expectedCurrentGeneration ?? null,
      code: 'unexpected_error',
    });
  }
}

export async function listAuthorizedRecoveryModes(jobId: number, userId: number) {
  const job = await db.query.jobs.findFirst({ where: eq(jobs.id, jobId) });
  if (
    !job ||
    ![JobStatus.FAILED, JobStatus.CANCELLED].includes(job.status as JobStatus) ||
    job.type === JobType.PUBLISH_RENDERED_CLIP
  ) return [];
  const lifecycle = await db.transaction(async (tx) =>
    await lockAndValidateLifecycle(tx, job, userId)
  );
  if ('code' in lifecycle) return [];
  const modes: JobRecoveryMode[] = [];
  if (job.failureClass === JobFailureClass.SAFE_NO_EXTERNAL_EFFECT) modes.push(JobRecoveryMode.RETRY);
  if (await getCompletedCheckpointForJob(job.id, job.type as JobType)) modes.push(JobRecoveryMode.RESUME);
  if (job.type === JobType.GENERATE_SHORT_FORM_PACK && lifecycle.pack) {
    modes.push(JobRecoveryMode.NEW_GENERATION);
  }
  return modes;
}

export async function listProjectRecoveryActions(projectId: number, userId: number) {
  const ownedSources = await db.select({ id: sourceAssets.id }).from(sourceAssets).where(and(
    eq(sourceAssets.projectId, projectId),
    eq(sourceAssets.userId, userId)
  ));
  if (ownedSources.length === 0) return [];

  const sourceMatches = sql.join(
    ownedSources.map(({ id }) =>
      sql`${jobs.payload}->'sourceAssetId' = to_jsonb(${id}::integer)`
    ),
    sql` or `
  );
  const terminalJobs = await db.select().from(jobs).where(and(
    inArray(jobs.status, [JobStatus.FAILED, JobStatus.CANCELLED]),
    sql<boolean>`jsonb_typeof(${jobs.payload}->'userId') = 'number'`,
    sql<boolean>`${jobs.payload}->'userId' = to_jsonb(${userId}::integer)`,
    sql<boolean>`jsonb_typeof(${jobs.payload}->'sourceAssetId') = 'number'`,
    sql<boolean>`(${sourceMatches})`,
    sql<boolean>`${jobs.type} <> ${JobType.PUBLISH_RENDERED_CLIP}`
  )).orderBy(desc(jobs.id));

  const actions = await Promise.all(terminalJobs.map(async (job) => {
    if (!Object.values(JobType).includes(job.type as JobType)) return null;
    const payload = parseJobPayloadForType(job.type, job.payload);
    if (
      !payload ||
      !('sourceAssetId' in payload) ||
      payload.userId !== userId ||
      typeof payload.sourceAssetId !== 'number' ||
      !ownedSources.some(({ id }) => id === payload.sourceAssetId)
    ) return null;
    const modes = await listAuthorizedRecoveryModes(job.id, userId);
    const mode = modes.includes(JobRecoveryMode.RESUME)
      ? JobRecoveryMode.RESUME
      : modes.includes(JobRecoveryMode.RETRY)
        ? JobRecoveryMode.RETRY
        : modes.includes(JobRecoveryMode.NEW_GENERATION)
          ? JobRecoveryMode.NEW_GENERATION
          : null;
    if (!mode) return null;
    return {
      sourceAssetId: payload.sourceAssetId,
      jobId: job.id,
      mode,
      expectedCurrentGeneration:
        mode === JobRecoveryMode.NEW_GENERATION &&
        'generationRunId' in payload &&
        typeof payload.generationRunId === 'string'
          ? payload.generationRunId
          : null,
    };
  }));
  return actions.filter((action): action is NonNullable<typeof action> => action !== null);
}
