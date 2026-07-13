import 'server-only';

import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db/drizzle';
import {
  clipCandidateFacecamDetectionRuns,
  clipCandidates,
  clipPublications,
  clipRenderConfigs,
  contentPacks,
  jobs,
  JobStatus,
  JobType,
  linkedAccounts,
  projects,
  RenderedClipLayout,
  RenderedClipVariant,
  renderedClips,
  sourceAssets,
  type Job,
} from '@/lib/db/schema';

export const JobCancellationReason = {
  USER_REQUESTED: 'user_requested',
  PROJECT_DELETING: 'project_deleting',
  SOURCE_ASSET_DELETING: 'source_asset_deleting',
  GENERATION_SUPERSEDED: 'generation_superseded',
  JOB_SUPERSEDED: 'job_superseded',
  LEASE_LOST: 'lease_lost',
  TRANSIENT_INTERRUPTION: 'transient_interruption',
} as const;

export type JobCancellationReason =
  (typeof JobCancellationReason)[keyof typeof JobCancellationReason];
export type JobExecutionAuthority = {
  jobId: number;
  leaseToken: string;
  signal?: AbortSignal;
};
export type JobExecutionAuthorizationFailureReason =
  | 'invalid_job_type'
  | 'invalid_payload'
  | 'job_missing'
  | 'job_not_processing'
  | 'lease_mismatch'
  | 'lease_expired'
  | 'cancellation_requested'
  | 'project_missing'
  | 'project_deleting'
  | 'source_asset_missing'
  | 'source_asset_deleting'
  | 'related_record_missing'
  | 'candidate_present'
  | 'relationship_mismatch'
  | 'generation_superseded';

export type AuthorizedJobContext = {
  job: Job;
  projectId: number;
  sourceAssetId: number;
  contentPackId: number | null;
  generationRunId: string | null;
};

export class JobExecutionUnauthorizedError extends Error {
  constructor(public readonly reason: JobExecutionAuthorizationFailureReason) {
    super(`Job execution is not authorized: ${reason}.`);
    this.name = 'JobExecutionUnauthorizedError';
  }
}

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type JobAuthorizationExecutor = typeof db | DbTransaction;

const baseSourceSchema = z.object({
  sourceAssetId: z.number().int().positive(),
  userId: z.number().int().positive(),
});
const generationSchema = baseSourceSchema.extend({
  contentPackId: z.number().int().positive(),
  generationRunId: z.string().trim().min(1),
});
const payloadSchemas: Partial<Record<JobType, z.ZodTypeAny>> = {
  [JobType.TRANSCRIBE_SOURCE_ASSET]: baseSourceSchema,
  [JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL]: baseSourceSchema,
  [JobType.INGEST_YOUTUBE_SOURCE_ASSET]: baseSourceSchema,
  [JobType.GENERATE_SHORT_FORM_PACK]: generationSchema.extend({
    transcriptId: z.number().int().positive().optional(),
    brandTemplateId: z.number().int().positive().optional(),
  }),
  [JobType.RENDER_CLIP_CANDIDATE]: generationSchema.extend({
    clipCandidateId: z.number().int().positive(),
    captionsEnabled: z.boolean().optional(),
    captionFontAssetId: z.number().int().positive().optional(),
  }),
  [JobType.FORMAT_RENDERED_CLIP_SHORT_FORM]: generationSchema.extend({
    clipCandidateId: z.number().int().positive(),
    renderConfigId: z.number().int().positive().optional(),
    variant: z.nativeEnum(RenderedClipVariant).optional(),
    layout: z.nativeEnum(RenderedClipLayout).optional(),
    captionsEnabled: z.boolean().optional(),
    captionFontAssetId: z.number().int().positive().optional(),
    editConfigHash: z.string().min(1).optional(),
  }),
  [JobType.DETECT_CLIP_FACECAM]: z.union([
    generationSchema.extend({
      clipCandidateId: z.number().int().positive(),
      startTimeMs: z.number().int().nonnegative(),
      endTimeMs: z.number().int().positive(),
      detectorVersion: z.string().trim().min(1),
      detectionRunId: z.number().int().positive(),
    }),
    baseSourceSchema.extend({
      videoId: z.number().int().positive(),
      contentPackId: z.number().int().positive().optional(),
      generationRunId: z.string().trim().min(1).optional(),
    }),
  ]),
  [JobType.PUBLISH_RENDERED_CLIP]: z.object({
    clipPublicationId: z.number().int().positive(),
    renderedClipId: z.number().int().positive(),
    linkedAccountId: z.number().int().positive(),
    userId: z.number().int().positive(),
    platform: z.enum(['youtube', 'tiktok']),
  }),
};

type ParsedPayload = Record<string, unknown> & { userId: number };
type JobResources = {
  projectId: number;
  sourceAssetId: number;
  contentPackId: number | null;
  generationRunId: string | null;
  clipCandidateId: number | null;
  renderConfigId: number | null;
  detectionRunId: number | null;
  renderedClipId: number | null;
  publicationId: number | null;
  linkedAccountId: number | null;
};

function parsePayload(job: Job): ParsedPayload {
  if (!Object.values(JobType).includes(job.type as JobType)) {
    throw new JobExecutionUnauthorizedError('invalid_job_type');
  }
  const parsed = payloadSchemas[job.type as JobType]?.safeParse(job.payload);
  if (!parsed?.success) {
    throw new JobExecutionUnauthorizedError('invalid_payload');
  }
  return parsed.data as ParsedPayload;
}

async function resolveResources(
  executor: JobAuthorizationExecutor,
  job: Job
): Promise<JobResources> {
  const payload = parsePayload(job);
  let sourceAssetId = payload.sourceAssetId as number | undefined;
  let contentPackId = (payload.contentPackId as number | undefined) ?? null;
  let generationRunId = (payload.generationRunId as string | undefined) ?? null;
  const renderedClipId = (payload.renderedClipId as number | undefined) ?? null;
  const publicationId = (payload.clipPublicationId as number | undefined) ?? null;
  const linkedAccountId = (payload.linkedAccountId as number | undefined) ?? null;
  let clipCandidateId = (payload.clipCandidateId as number | undefined) ?? null;

  if (job.type === JobType.PUBLISH_RENDERED_CLIP) {
    const [publication] = await executor.select().from(clipPublications)
      .where(eq(clipPublications.id, publicationId!)).limit(1);
    const [renderedClip] = await executor.select().from(renderedClips)
      .where(eq(renderedClips.id, renderedClipId!)).limit(1);
    const [account] = await executor.select().from(linkedAccounts)
      .where(eq(linkedAccounts.id, linkedAccountId!)).limit(1);
    if (!publication || !renderedClip || !account) {
      throw new JobExecutionUnauthorizedError('related_record_missing');
    }
    if (
      publication.renderedClipId !== renderedClip.id ||
      publication.linkedAccountId !== account.id ||
      publication.userId !== payload.userId ||
      renderedClip.userId !== payload.userId ||
      account.userId !== payload.userId ||
      publication.platform !== payload.platform ||
      account.platform !== payload.platform
    ) {
      throw new JobExecutionUnauthorizedError('relationship_mismatch');
    }
    sourceAssetId = renderedClip.sourceAssetId;
    contentPackId = renderedClip.contentPackId;
    generationRunId = renderedClip.generationRunId;
    clipCandidateId = renderedClip.clipCandidateId;
  }

  if (!sourceAssetId) {
    throw new JobExecutionUnauthorizedError('invalid_payload');
  }
  if (
    job.type === JobType.DETECT_CLIP_FACECAM &&
    payload.videoId &&
    payload.videoId !== sourceAssetId
  ) {
    throw new JobExecutionUnauthorizedError('relationship_mismatch');
  }

  const [source] = await executor.select().from(sourceAssets)
    .where(eq(sourceAssets.id, sourceAssetId)).limit(1);
  if (!source) throw new JobExecutionUnauthorizedError('source_asset_missing');
  if (source.userId !== payload.userId) {
    throw new JobExecutionUnauthorizedError('relationship_mismatch');
  }
  const [project] = await executor.select().from(projects)
    .where(eq(projects.id, source.projectId)).limit(1);
  if (!project) throw new JobExecutionUnauthorizedError('project_missing');
  if (project.userId !== payload.userId) {
    throw new JobExecutionUnauthorizedError('relationship_mismatch');
  }

  if (contentPackId) {
    const [pack] = await executor.select().from(contentPacks)
      .where(eq(contentPacks.id, contentPackId)).limit(1);
    if (!pack) throw new JobExecutionUnauthorizedError('related_record_missing');
    if (
      pack.projectId !== project.id ||
      pack.sourceAssetId !== source.id ||
      pack.userId !== payload.userId
    ) throw new JobExecutionUnauthorizedError('relationship_mismatch');
    if (generationRunId && pack.generationRunId !== generationRunId) {
      throw new JobExecutionUnauthorizedError('generation_superseded');
    }
  }

  const renderConfigId = (payload.renderConfigId as number | undefined) ?? null;
  const detectionRunId = (payload.detectionRunId as number | undefined) ?? null;
  if (clipCandidateId) {
    const [record] = await executor.select().from(clipCandidates)
      .where(eq(clipCandidates.id, clipCandidateId)).limit(1);
    if (!record) throw new JobExecutionUnauthorizedError('related_record_missing');
    if (
      record.sourceAssetId !== source.id || record.contentPackId !== contentPackId ||
      record.userId !== payload.userId || record.generationRunId !== generationRunId
    ) throw new JobExecutionUnauthorizedError('relationship_mismatch');
  }
  if (renderConfigId) {
    const [record] = await executor.select().from(clipRenderConfigs)
      .where(eq(clipRenderConfigs.id, renderConfigId)).limit(1);
    if (!record) throw new JobExecutionUnauthorizedError('related_record_missing');
    if (record.sourceAssetId !== source.id || record.contentPackId !== contentPackId ||
      record.userId !== payload.userId || record.generationRunId !== generationRunId ||
      (clipCandidateId && record.clipCandidateId !== clipCandidateId)) {
      throw new JobExecutionUnauthorizedError('relationship_mismatch');
    }
  }
  if (detectionRunId) {
    const [record] = await executor.select().from(clipCandidateFacecamDetectionRuns)
      .where(eq(clipCandidateFacecamDetectionRuns.id, detectionRunId)).limit(1);
    if (!record) throw new JobExecutionUnauthorizedError('related_record_missing');
    if (record.sourceAssetId !== source.id || record.contentPackId !== contentPackId ||
      record.userId !== payload.userId || record.generationRunId !== generationRunId ||
      (clipCandidateId && record.clipCandidateId !== clipCandidateId)) {
      throw new JobExecutionUnauthorizedError('relationship_mismatch');
    }
  }

  return {
    projectId: project.id, sourceAssetId: source.id, contentPackId, generationRunId,
    clipCandidateId, renderConfigId, detectionRunId, renderedClipId,
    publicationId, linkedAccountId,
  };
}

async function resolveMissingCandidateCancellationResources(
  executor: JobAuthorizationExecutor,
  job: Job
): Promise<JobResources> {
  if (
    job.type !== JobType.RENDER_CLIP_CANDIDATE &&
    job.type !== JobType.FORMAT_RENDERED_CLIP_SHORT_FORM &&
    job.type !== JobType.DETECT_CLIP_FACECAM
  ) {
    throw new JobExecutionUnauthorizedError('invalid_job_type');
  }

  const payload = parsePayload(job);
  const sourceAssetId = payload.sourceAssetId as number | undefined;
  const contentPackId = payload.contentPackId as number | undefined;
  const generationRunId = payload.generationRunId as string | undefined;
  const clipCandidateId = payload.clipCandidateId as number | undefined;
  if (!sourceAssetId || !contentPackId || !generationRunId || !clipCandidateId) {
    throw new JobExecutionUnauthorizedError('invalid_payload');
  }

  const [source] = await executor.select().from(sourceAssets)
    .where(eq(sourceAssets.id, sourceAssetId)).limit(1);
  if (!source) throw new JobExecutionUnauthorizedError('source_asset_missing');
  if (source.userId !== payload.userId) {
    throw new JobExecutionUnauthorizedError('relationship_mismatch');
  }
  const [project] = await executor.select().from(projects)
    .where(eq(projects.id, source.projectId)).limit(1);
  if (!project) throw new JobExecutionUnauthorizedError('project_missing');
  if (project.userId !== payload.userId) {
    throw new JobExecutionUnauthorizedError('relationship_mismatch');
  }
  const [pack] = await executor.select().from(contentPacks)
    .where(eq(contentPacks.id, contentPackId)).limit(1);
  if (!pack) throw new JobExecutionUnauthorizedError('related_record_missing');
  if (
    pack.projectId !== project.id ||
    pack.sourceAssetId !== source.id ||
    pack.userId !== payload.userId
  ) {
    throw new JobExecutionUnauthorizedError('relationship_mismatch');
  }
  if (pack.generationRunId !== generationRunId) {
    throw new JobExecutionUnauthorizedError('generation_superseded');
  }

  const [candidate] = await executor.select({ id: clipCandidates.id })
    .from(clipCandidates).where(eq(clipCandidates.id, clipCandidateId)).limit(1);
  if (candidate) throw new JobExecutionUnauthorizedError('candidate_present');

  return {
    projectId: project.id,
    sourceAssetId: source.id,
    contentPackId: pack.id,
    generationRunId,
    clipCandidateId,
    renderConfigId: null,
    detectionRunId: null,
    renderedClipId: null,
    publicationId: null,
    linkedAccountId: null,
  };
}

async function assertRowAuthority(
  executor: JobAuthorizationExecutor,
  authority: JobExecutionAuthority,
  job: Job
) {
  if (job.cancellationRequestedAt) throw new JobExecutionUnauthorizedError('cancellation_requested');
  if (job.status !== JobStatus.PROCESSING) throw new JobExecutionUnauthorizedError('job_not_processing');
  if (job.leaseToken !== authority.leaseToken) throw new JobExecutionUnauthorizedError('lease_mismatch');
  const [row] = await executor.execute<{ valid: boolean }>(sql`
    select exists(
      select 1 from "jobs"
      where "id" = ${job.id}
        and "lease_expires_at" > clock_timestamp()
    ) as valid
  `);
  if (!job.leaseExpiresAt || !row.valid) throw new JobExecutionUnauthorizedError('lease_expired');
}

async function assertLifecycle(executor: JobAuthorizationExecutor, resources: JobResources) {
  const [project] = await executor.select({ deletionRequestedAt: projects.deletionRequestedAt })
    .from(projects).where(eq(projects.id, resources.projectId)).limit(1);
  const [source] = await executor.select({ deletionRequestedAt: sourceAssets.deletionRequestedAt })
    .from(sourceAssets).where(eq(sourceAssets.id, resources.sourceAssetId)).limit(1);
  if (!project) throw new JobExecutionUnauthorizedError('project_missing');
  if (project.deletionRequestedAt) throw new JobExecutionUnauthorizedError('project_deleting');
  if (!source) throw new JobExecutionUnauthorizedError('source_asset_missing');
  if (source.deletionRequestedAt) throw new JobExecutionUnauthorizedError('source_asset_deleting');
}

async function authorize(
  authority: JobExecutionAuthority,
  executor: JobAuthorizationExecutor,
  lock: boolean
): Promise<AuthorizedJobContext> {
  if (authority.signal?.aborted) {
    throw new JobExecutionUnauthorizedError('lease_mismatch');
  }
  const [initialJob] = await executor.select().from(jobs)
    .where(eq(jobs.id, authority.jobId)).limit(1);
  if (!initialJob) throw new JobExecutionUnauthorizedError('job_missing');
  const initial = await resolveResources(executor, initialJob);

  if (lock) {
    // Lifecycle writers must use this project-to-job order to avoid deadlocks.
    await executor.select({ id: projects.id }).from(projects)
      .where(eq(projects.id, initial.projectId)).for('update');
    await executor.select({ id: sourceAssets.id }).from(sourceAssets)
      .where(eq(sourceAssets.id, initial.sourceAssetId)).for('update');
    if (initial.contentPackId) await executor.select({ id: contentPacks.id }).from(contentPacks)
      .where(eq(contentPacks.id, initial.contentPackId)).for('update');
    if (initial.clipCandidateId) await executor.select({ id: clipCandidates.id }).from(clipCandidates)
      .where(eq(clipCandidates.id, initial.clipCandidateId)).for('update');
    if (initial.renderConfigId) await executor.select({ id: clipRenderConfigs.id }).from(clipRenderConfigs)
      .where(eq(clipRenderConfigs.id, initial.renderConfigId)).for('update');
    if (initial.detectionRunId) await executor.select({ id: clipCandidateFacecamDetectionRuns.id }).from(clipCandidateFacecamDetectionRuns)
      .where(eq(clipCandidateFacecamDetectionRuns.id, initial.detectionRunId)).for('update');
    if (initial.renderedClipId) await executor.select({ id: renderedClips.id }).from(renderedClips)
      .where(eq(renderedClips.id, initial.renderedClipId)).for('update');
    if (initial.publicationId) await executor.select({ id: clipPublications.id }).from(clipPublications)
      .where(eq(clipPublications.id, initial.publicationId)).for('update');
    if (initial.linkedAccountId) await executor.select({ id: linkedAccounts.id }).from(linkedAccounts)
      .where(eq(linkedAccounts.id, initial.linkedAccountId)).for('update');
  }

  const [job] = lock
    ? await executor.select().from(jobs).where(eq(jobs.id, authority.jobId))
        .for('update').limit(1)
    : await executor.select().from(jobs).where(eq(jobs.id, authority.jobId))
        .limit(1);
  if (!job) throw new JobExecutionUnauthorizedError('job_missing');
  const resources = await resolveResources(executor, job);
  if (JSON.stringify(resources) !== JSON.stringify(initial)) {
    throw new JobExecutionUnauthorizedError('relationship_mismatch');
  }
  await assertRowAuthority(executor, authority, job);
  await assertLifecycle(executor, resources);
  return { job, projectId: resources.projectId, sourceAssetId: resources.sourceAssetId,
    contentPackId: resources.contentPackId, generationRunId: resources.generationRunId };
}

async function authorizeMissingCandidateCancellation(
  authority: JobExecutionAuthority,
  executor: JobAuthorizationExecutor
): Promise<AuthorizedJobContext> {
  if (authority.signal?.aborted) {
    throw new JobExecutionUnauthorizedError('lease_mismatch');
  }
  const [initialJob] = await executor.select().from(jobs)
    .where(eq(jobs.id, authority.jobId)).limit(1);
  if (!initialJob) throw new JobExecutionUnauthorizedError('job_missing');
  const initial = await resolveMissingCandidateCancellationResources(executor, initialJob);

  await executor.select({ id: projects.id }).from(projects)
    .where(eq(projects.id, initial.projectId)).for('update');
  await executor.select({ id: sourceAssets.id }).from(sourceAssets)
    .where(eq(sourceAssets.id, initial.sourceAssetId)).for('update');
  await executor.select({ id: contentPacks.id }).from(contentPacks)
    .where(eq(contentPacks.id, initial.contentPackId!)).for('update');

  const [job] = await executor.select().from(jobs)
    .where(eq(jobs.id, authority.jobId)).for('update').limit(1);
  if (!job) throw new JobExecutionUnauthorizedError('job_missing');
  const resources = await resolveMissingCandidateCancellationResources(executor, job);
  if (JSON.stringify(resources) !== JSON.stringify(initial)) {
    throw new JobExecutionUnauthorizedError('relationship_mismatch');
  }
  await assertRowAuthority(executor, authority, job);
  await assertLifecycle(executor, resources);
  return {
    job,
    projectId: resources.projectId,
    sourceAssetId: resources.sourceAssetId,
    contentPackId: resources.contentPackId,
    generationRunId: resources.generationRunId,
  };
}

export async function assertJobExecutionAuthorized(
  authority: JobExecutionAuthority,
  executor: JobAuthorizationExecutor = db
) {
  if (authority.signal?.aborted) {
    throw new JobExecutionUnauthorizedError('lease_mismatch');
  }
  return await authorize(authority, executor, false);
}

export async function withAuthorizedJobTransaction<T>(
  authority: JobExecutionAuthority,
  effect: (tx: DbTransaction, context: AuthorizedJobContext) => Promise<T>,
  executor?: DbTransaction,
  finalize?: (tx: DbTransaction, context: AuthorizedJobContext) => Promise<void>
) {
  const run = async (tx: DbTransaction) => {
    const context = await authorize(authority, tx, true);
    const result = await effect(tx, context);
    const finalContext = await authorize(authority, tx, true);
    await finalize?.(tx, finalContext);
    return result;
  };
  return executor ? await run(executor) : await db.transaction(run);
}

export async function withAuthorizedMissingCandidateCancellationTransaction<T>(
  authority: JobExecutionAuthority,
  effect: (tx: DbTransaction, context: AuthorizedJobContext) => Promise<T>,
  finalize: (tx: DbTransaction, context: AuthorizedJobContext) => Promise<void>
) {
  return await db.transaction(async (tx) => {
    const context = await authorizeMissingCandidateCancellation(authority, tx);
    const result = await effect(tx, context);
    const [candidate] = await tx.select({ id: clipCandidates.id })
      .from(clipCandidates)
      .where(eq(clipCandidates.id, (context.job.payload as { clipCandidateId: number }).clipCandidateId))
      .limit(1);
    if (candidate) throw new JobExecutionUnauthorizedError('candidate_present');
    const [job] = await tx.select().from(jobs)
      .where(eq(jobs.id, authority.jobId)).for('update').limit(1);
    if (!job) throw new JobExecutionUnauthorizedError('job_missing');
    await assertRowAuthority(tx, authority, job);
    await assertLifecycle(tx, {
      projectId: context.projectId,
      sourceAssetId: context.sourceAssetId,
      contentPackId: context.contentPackId,
      generationRunId: context.generationRunId,
      clipCandidateId: null,
      renderConfigId: null,
      detectionRunId: null,
      renderedClipId: null,
      publicationId: null,
      linkedAccountId: null,
    });
    const finalContext = { ...context, job };
    await finalize(tx, finalContext);
    return result;
  });
}
