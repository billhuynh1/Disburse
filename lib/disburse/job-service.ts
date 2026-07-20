import 'server-only';
import { assertDirectPublishingProhibited } from '@/lib/disburse/publishing-prohibition';

import { randomUUID } from 'node:crypto';

import { and, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import {
  FACECAM_DETECTION_STALE_FAILURE_REASON,
  FACECAM_DETECTION_STALE_MS,
  isStaleFacecamDetectionStartedAt,
} from '@/lib/disburse/facecam-recovery';
import {
  clipCandidateFacecamDetectionRuns,
  clipCandidateFacecamDetections,
  clipCandidates,
  clipEditConfigs,
  contentPacks,
  ContentPackKind,
  ContentPackStatus,
  FacecamDetectionStatus,
  jobs,
  jobEffectCheckpoints,
  JobEffectCheckpointStatus,
  pipelineSchedulerState,
  JobStatus,
  JobType,
  JobFailureClass,
  projects,
  RenderedClipLayout,
  renderedClips,
  RenderedClipStatus,
  RenderedClipVariant,
  sourceAssets,
  SourceAssetStatus,
  SourceAssetType,
  transcripts,
  TranscriptStatus,
  type DetectClipFacecamJobPayload,
  type ExtractSourceAssetThumbnailJobPayload,
  type PublishRenderedClipJobPayload,
  type GenerateShortFormPackJobPayload,
  type FormatRenderedClipShortFormJobPayload,
  type RenderClipCandidateJobPayload,
  type IngestYoutubeSourceAssetJobPayload,
  type Job,
  type JobPayload,
  type TranscribeSourceAssetJobPayload,
  users,
} from '@/lib/db/schema';
import {
  createGenerationRunId,
  isStaleGenerationRun,
} from '@/lib/disburse/generation-run-service';
import { StaleJobReason } from '@/lib/disburse/stale-job';
import { buildJobIdempotencyKey } from '@/lib/disburse/job-identity';
import { classifyFormatRenderJob } from '@/lib/disburse/render-job-compatibility';
import {
  type AuthorizedJobContext,
  type JobExecutionAuthority,
  JobExecutionUnauthorizedError,
  withAuthorizedMissingCandidateCancellationTransaction,
  withAuthorizedJobSuccessTransaction,
  withAuthorizedJobTransaction,
} from '@/lib/disburse/job-execution-authorization';
import {
  buildCandidateFacecamIdempotencyKey,
  buildFacecamIdempotencyKey,
  FACECAM_DETECTOR_VERSION,
} from '@/lib/disburse/facecam-detection-service';
import {
  detectClipFacecamJobPayloadSchema,
  extractSourceAssetThumbnailJobPayloadSchema,
  formatRenderedClipShortFormJobPayloadSchema,
  generateShortFormPackJobPayloadSchema,
  ingestYoutubeSourceAssetJobPayloadSchema,
  publishRenderedClipJobPayloadSchema,
  renderClipCandidateJobPayloadSchema,
  transcribeSourceAssetJobPayloadSchema,
  parseJobPayloadForType,
} from '@/lib/disburse/job-payload-schema';
import { PRIMARY_JOB_EFFECT_KEY } from '@/lib/disburse/job-effect-checkpoint-service';
import { parseJobEffectCheckpointResult } from '@/lib/disburse/job-effect-checkpoint-schema';

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = typeof db | DbTransaction;
export type FacecamDetectionEnqueueResult = {
  job: Job;
  status:
    | 'created_pending'
    | 'reused_pending'
    | 'reused_processing'
    | 'reused_completed';
};

const RECOVERABLE_TRANSCRIPTION_SOURCE_STATUSES = new Set<string>([
  SourceAssetStatus.UPLOADED,
  SourceAssetStatus.PROCESSING,
]);
const RECOVERABLE_TRANSCRIPTION_STATUSES = new Set<string>([
  TranscriptStatus.PENDING,
  TranscriptStatus.PROCESSING,
]);
const RECOVERABLE_FACECAM_DETECTION_STATUSES = new Set<string>([
  FacecamDetectionStatus.PENDING,
  FacecamDetectionStatus.DETECTING,
]);
const SHORT_FORM_PACK_STALE_FAILURE_REASON =
  'Clip candidate generation stalled. Please run setup again.';
const SHORT_FORM_PACK_EMPTY_FAILURE_REASON =
  'Clip candidate generation completed without creating usable clips. Please run setup again.';
const DEFAULT_RENDER_CONCURRENCY =
  process.env.NODE_ENV === 'production' ? 1 : 1;
const DEFAULT_FACECAM_CONCURRENCY =
  process.env.NODE_ENV === 'production' ? 1 : 1;
const DEFAULT_JOB_LEASE_MS = 15 * 60 * 1000;

export class JobLeaseLostError extends Error {
  constructor() {
    super('Job lease was lost.');
    this.name = 'JobLeaseLostError';
  }
}

export class JobEnqueueBlockedError extends Error {
  constructor() {
    super('New work cannot be queued while this project or source asset is being deleted.');
    this.name = 'JobEnqueueBlockedError';
  }
}

async function withJobEnqueueBarrier<T>(
  executor: DbLike,
  sourceAssetId: number,
  userId: number,
  enqueue: (executor: DbTransaction) => Promise<T>
): Promise<T> {
  const run = async (tx: DbTransaction) => {
    const [sourceReference] = await tx
      .select({ projectId: sourceAssets.projectId })
      .from(sourceAssets)
      .where(and(eq(sourceAssets.id, sourceAssetId), eq(sourceAssets.userId, userId)))
      .limit(1);

    if (!sourceReference) {
      throw new Error('Source asset not found.');
    }

    const [project] = await tx
      .select({ deletionRequestedAt: projects.deletionRequestedAt })
      .from(projects)
      .where(and(eq(projects.id, sourceReference.projectId), eq(projects.userId, userId)))
      .for('update')
      .limit(1);
    const [sourceAsset] = await tx
      .select({ deletionRequestedAt: sourceAssets.deletionRequestedAt })
      .from(sourceAssets)
      .where(and(eq(sourceAssets.id, sourceAssetId), eq(sourceAssets.userId, userId)))
      .for('update')
      .limit(1);

    if (!project || !sourceAsset) {
      throw new Error('Source asset not found.');
    }
    if (project.deletionRequestedAt || sourceAsset.deletionRequestedAt) {
      throw new JobEnqueueBlockedError();
    }

    return await enqueue(tx);
  };

  return executor === db
    ? await db.transaction(run)
    : await run(executor as DbTransaction);
}

export function isJobLeaseLostError(error: unknown): error is JobLeaseLostError {
  return error instanceof JobLeaseLostError;
}

function getMaxRenderConcurrency() {
  const value = Number(process.env.MAX_RENDER_CONCURRENCY);

  if (!Number.isFinite(value) || value < 1) {
    return DEFAULT_RENDER_CONCURRENCY;
  }

  return Math.floor(value);
}

function getMaxFacecamConcurrency() {
  const value = Number(process.env.MAX_FACECAM_CONCURRENCY);

  if (!Number.isFinite(value) || value < 1) {
    return DEFAULT_FACECAM_CONCURRENCY;
  }

  return Math.floor(value);
}

function shouldRetryEmptyUploadedShortFormPack(params: {
  sourceAssetType: string;
  clipCandidateCount: number;
  hasCompletedGenerateJob: boolean;
  hasMissingCandidateCancellation: boolean;
}) {
  return (
    params.sourceAssetType === SourceAssetType.UPLOADED_FILE &&
    params.clipCandidateCount === 0 &&
    params.hasCompletedGenerateJob &&
    params.hasMissingCandidateCancellation
  );
}

export type ClaimedPipelineJob =
  | (Job & {
      type: JobType.TRANSCRIBE_SOURCE_ASSET;
      payload: TranscribeSourceAssetJobPayload;
    })
  | (Job & {
      type: JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL;
      payload: ExtractSourceAssetThumbnailJobPayload;
    })
  | (Job & {
      type: JobType.INGEST_YOUTUBE_SOURCE_ASSET;
      payload: IngestYoutubeSourceAssetJobPayload;
    })
  | (Job & {
      type: JobType.GENERATE_SHORT_FORM_PACK;
      payload: GenerateShortFormPackJobPayload;
    })
  | (Job & {
      type: JobType.RENDER_CLIP_CANDIDATE;
      payload: RenderClipCandidateJobPayload;
    })
  | (Job & {
      type: JobType.FORMAT_RENDERED_CLIP_SHORT_FORM;
      payload: FormatRenderedClipShortFormJobPayload;
    })
  | (Job & {
      type: JobType.DETECT_CLIP_FACECAM;
      payload: DetectClipFacecamJobPayload;
    })
  | (Job & {
      type: JobType.PUBLISH_RENDERED_CLIP;
      payload: PublishRenderedClipJobPayload;
    });

export {
  FACECAM_DETECTION_STALE_FAILURE_REASON,
  FACECAM_DETECTION_STALE_MS,
  isStaleFacecamDetectionStartedAt,
};

function normalizeFailureReason(reason: string) {
  const normalized = reason.trim();
  return normalized.length > 0 ? normalized.slice(0, 5000) : 'Job failed.';
}

function buildCancelledReason(reason: string | StaleJobReason) {
  return normalizeFailureReason(reason);
}

async function insertOrReuseJob(
  executor: DbLike,
  values: typeof jobs.$inferInsert
) {
  const [createdJob] = await executor
    .insert(jobs)
    .values(values)
    .onConflictDoNothing({ target: jobs.idempotencyKey })
    .returning();

  if (createdJob) {
    return createdJob;
  }

  const existingJob = await executor.query.jobs.findFirst({
    where: eq(jobs.idempotencyKey, values.idempotencyKey),
  });

  if (!existingJob) {
    throw new Error('Job identity conflict could not be resolved.');
  }

  return existingJob;
}

export async function insertOrReuseReconciliationJob(
  values: typeof jobs.$inferInsert,
  executor: DbLike
) {
  if (values.type === JobType.PUBLISH_RENDERED_CLIP) {
    throw new Error('Publishing work cannot be created by pipeline reconciliation.');
  }

  return await insertOrReuseJob(executor, values);
}

async function ensurePendingTranscript(
  executor: DbLike,
  payload: TranscribeSourceAssetJobPayload | IngestYoutubeSourceAssetJobPayload
) {
  const [existingTranscript] = await executor
    .select({
      id: transcripts.id,
      status: transcripts.status,
    })
    .from(transcripts)
    .where(
      and(
        eq(transcripts.sourceAssetId, payload.sourceAssetId),
        eq(transcripts.userId, payload.userId)
      )
    )
    .limit(1);

  if (existingTranscript?.status === TranscriptStatus.READY) {
    return existingTranscript;
  }

  if (existingTranscript) {
    const [updatedTranscript] = await executor
      .update(transcripts)
      .set({
        status: TranscriptStatus.PENDING,
        failureReason: null,
        updatedAt: new Date(),
      })
      .where(eq(transcripts.id, existingTranscript.id))
      .returning({
        id: transcripts.id,
        status: transcripts.status,
      });

    return updatedTranscript;
  }

  const [transcript] = await executor
    .insert(transcripts)
    .values({
      userId: payload.userId,
      sourceAssetId: payload.sourceAssetId,
      status: TranscriptStatus.PENDING,
    })
    .returning({
      id: transcripts.id,
      status: transcripts.status,
    });

  return transcript;
}

async function findActiveSourceAssetJob(
  executor: DbLike,
  type: JobType.TRANSCRIBE_SOURCE_ASSET | JobType.INGEST_YOUTUBE_SOURCE_ASSET,
  sourceAssetId: number
) {
  return await executor.query.jobs.findFirst({
    where: and(
      eq(jobs.type, type),
      inArray(jobs.status, [JobStatus.PENDING, JobStatus.PROCESSING]),
      sql<boolean>`payload->>'sourceAssetId' = ${String(sourceAssetId)}`
    ),
  });
}

async function findCompletedSourceAssetJob(
  executor: DbLike,
  type: JobType.TRANSCRIBE_SOURCE_ASSET | JobType.INGEST_YOUTUBE_SOURCE_ASSET,
  sourceAssetId: number
) {
  return await executor.query.jobs.findFirst({
    where: and(
      eq(jobs.type, type),
      eq(jobs.status, JobStatus.COMPLETED),
      sql<boolean>`payload->>'sourceAssetId' = ${String(sourceAssetId)}`
    ),
  });
}

async function findActiveTranscriptionJob(
  executor: DbLike,
  sourceAssetId: number
) {
  return await executor.query.jobs.findFirst({
    where: and(
      inArray(jobs.type, [
        JobType.TRANSCRIBE_SOURCE_ASSET,
        JobType.INGEST_YOUTUBE_SOURCE_ASSET,
      ]),
      inArray(jobs.status, [JobStatus.PENDING, JobStatus.PROCESSING]),
      sql<boolean>`payload->>'sourceAssetId' = ${String(sourceAssetId)}`
    ),
  });
}

async function findActiveShortFormJob(
  executor: DbLike,
  contentPackId: number
) {
  return await executor.query.jobs.findFirst({
    where: and(
      eq(jobs.type, JobType.GENERATE_SHORT_FORM_PACK),
      inArray(jobs.status, [JobStatus.PENDING, JobStatus.PROCESSING]),
      sql<boolean>`payload->>'contentPackId' = ${String(contentPackId)}`
    ),
  });
}

async function findActiveShortFormPipelineJob(
  executor: DbLike,
  contentPackId: number
) {
  return await executor.query.jobs.findFirst({
    where: and(
      inArray(jobs.type, [
        JobType.GENERATE_SHORT_FORM_PACK,
        JobType.DETECT_CLIP_FACECAM,
        JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
        JobType.RENDER_CLIP_CANDIDATE,
      ]),
      inArray(jobs.status, [JobStatus.PENDING, JobStatus.PROCESSING]),
      sql<boolean>`payload->>'contentPackId' = ${String(contentPackId)}`
    ),
    orderBy: (jobs, { asc }) => [asc(jobs.createdAt)],
  });
}

async function findCompletedShortFormJob(
  executor: DbLike,
  contentPackId: number
) {
  return await executor.query.jobs.findFirst({
    where: and(
      eq(jobs.type, JobType.GENERATE_SHORT_FORM_PACK),
      eq(jobs.status, JobStatus.COMPLETED),
      sql<boolean>`payload->>'contentPackId' = ${String(contentPackId)}`
    ),
    orderBy: (jobs, { desc }) => [desc(jobs.completedAt), desc(jobs.updatedAt)],
  });
}

async function countCompletedShortFormJobs(
  executor: DbLike,
  contentPackId: number
) {
  const [result] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, JobType.GENERATE_SHORT_FORM_PACK),
        eq(jobs.status, JobStatus.COMPLETED),
        sql<boolean>`payload->>'contentPackId' = ${String(contentPackId)}`
      )
    );

  return result?.count ?? 0;
}

async function hasMissingCandidateCancellationForGeneration(
  executor: DbLike,
  contentPackId: number,
  generationRunId: string
) {
  const cancelledJob = await executor.query.jobs.findFirst({
    where: and(
      inArray(jobs.type, [
        JobType.DETECT_CLIP_FACECAM,
        JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
        JobType.RENDER_CLIP_CANDIDATE,
      ]),
      eq(jobs.status, JobStatus.CANCELLED),
      eq(jobs.failureReason, 'clip_candidate_missing'),
      sql<boolean>`payload->>'contentPackId' = ${String(contentPackId)}`,
      sql<boolean>`coalesce(payload->>'generationRunId', '') = ${generationRunId}`
    ),
  });

  return Boolean(cancelledJob);
}

async function findActiveRenderJob(executor: DbLike, clipCandidateId: number) {
  return await executor.query.jobs.findFirst({
    where: and(
      inArray(jobs.type, [
        JobType.RENDER_CLIP_CANDIDATE,
        JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
      ]),
      inArray(jobs.status, [JobStatus.PENDING, JobStatus.PROCESSING]),
      sql<boolean>`payload->>'clipCandidateId' = ${String(clipCandidateId)}`
    ),
  });
}

async function assertClipCandidateCanQueueRender(
  executor: DbLike,
  clipCandidateId: number
) {
  const candidate = await executor.query.clipCandidates.findFirst({
    where: eq(clipCandidates.id, clipCandidateId),
    columns: {
      id: true,
      contentPackId: true,
      generationRunId: true,
    },
    with: {
      contentPack: {
        columns: {
          kind: true,
        },
      },
      sourceAsset: {
        columns: {
          assetType: true,
          mimeType: true,
        },
      },
    },
  });

  if (!candidate) {
    throw new Error('Clip candidate not found.');
  }

  return candidate;
}

export async function isCurrentContentPackGenerationRun(
  contentPackId: number,
  generationRunId: string,
  executor: DbLike = db
) {
  const [contentPack] = await executor
    .select({
      generationRunId: contentPacks.generationRunId,
    })
    .from(contentPacks)
    .where(eq(contentPacks.id, contentPackId))
    .limit(1);

  if (!contentPack) {
    return false;
  }

  return !isStaleGenerationRun(contentPack.generationRunId, generationRunId);
}

async function findActiveRenderJobByType(
  executor: DbLike,
  type: JobType.RENDER_CLIP_CANDIDATE | JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
  clipCandidateId: number
) {
  return await executor.query.jobs.findFirst({
    where: and(
      eq(jobs.type, type),
      inArray(jobs.status, [JobStatus.PENDING, JobStatus.PROCESSING]),
      sql<boolean>`payload->>'clipCandidateId' = ${String(clipCandidateId)}`
    ),
  });
}

async function findActiveFormatRenderJob(
  executor: DbLike,
  clipCandidateId: number,
  contentPackId: number,
  sourceAssetId: number,
  userId: number,
  variant: RenderedClipVariant,
  layout: RenderedClipLayout,
  editConfigHash: string | undefined,
  generationRunId: string,
  renderConfigId: number | undefined,
  editConfigId: number | undefined
) {
  const candidates = await executor.query.jobs.findMany({
    where: and(
      eq(jobs.type, JobType.FORMAT_RENDERED_CLIP_SHORT_FORM),
      inArray(jobs.status, [JobStatus.PENDING, JobStatus.PROCESSING]),
      sql<boolean>`payload->>'clipCandidateId' = ${String(clipCandidateId)}`,
      sql<boolean>`coalesce(payload->>'variant', ${RenderedClipVariant.VERTICAL_SHORT_FORM}) = ${variant}`,
      sql<boolean>`coalesce(payload->>'layout', ${RenderedClipLayout.DEFAULT}) = ${layout}`,
      sql<boolean>`coalesce(payload->>'editConfigHash', '') = ${editConfigHash ?? ''}`
    ),
  });
  return candidates.find((job) => ['exact', 'legacy_active_blocker'].includes(
    classifyFormatRenderJob(job, {
      clipCandidateId,
      contentPackId,
      sourceAssetId,
      userId,
      generationRunId,
      variant,
      layout,
      editConfigHash,
      renderConfigId,
      editConfigId,
    })
  ));
}

async function findCurrentRenderedClipForConfig(
  executor: DbLike,
  clipCandidateId: number,
  variant: RenderedClipVariant,
  layout: RenderedClipLayout,
  editConfigHash: string | undefined,
  generationRunId: string,
  renderConfigId: number | undefined,
  editConfigId: number | undefined
) {
  if (!editConfigHash) {
    return null;
  }

  return await executor.query.renderedClips.findFirst({
    where: and(
      eq(renderedClips.clipCandidateId, clipCandidateId),
      eq(renderedClips.variant, variant),
      eq(renderedClips.layout, layout),
      eq(renderedClips.editConfigHash, editConfigHash),
      eq(renderedClips.generationRunId, generationRunId),
      renderConfigId
        ? eq(renderedClips.clipRenderConfigId, renderConfigId)
        : eq(renderedClips.editConfigId, editConfigId!),
      inArray(renderedClips.status, [
        RenderedClipStatus.PENDING,
        RenderedClipStatus.RENDERING,
        RenderedClipStatus.READY,
      ])
    ),
  });
}

async function findActiveFacecamDetectionJob(
  executor: DbLike,
  clipCandidateId: number,
  generationRunId: string
) {
  return await executor.query.jobs.findFirst({
    where: and(
      eq(jobs.type, JobType.DETECT_CLIP_FACECAM),
      inArray(jobs.status, [JobStatus.PENDING, JobStatus.PROCESSING]),
      sql<boolean>`payload->>'clipCandidateId' = ${String(clipCandidateId)}`,
      sql<boolean>`coalesce(payload->>'generationRunId', '') = ${generationRunId}`
    ),
  });
}

async function findPendingFacecamDetectionJob(
  executor: DbLike,
  clipCandidateId: number,
  generationRunId: string
) {
  return await executor.query.jobs.findFirst({
    where: and(
      eq(jobs.type, JobType.DETECT_CLIP_FACECAM),
      eq(jobs.status, JobStatus.PENDING),
      sql<boolean>`payload->>'clipCandidateId' = ${String(clipCandidateId)}`,
      sql<boolean>`coalesce(payload->>'generationRunId', '') = ${generationRunId}`
    ),
  });
}

async function findCompletedFacecamDetectionJob(
  executor: DbLike,
  clipCandidateId: number,
  generationRunId: string
) {
  return await executor.query.jobs.findFirst({
    where: and(
      eq(jobs.type, JobType.DETECT_CLIP_FACECAM),
      eq(jobs.status, JobStatus.COMPLETED),
      sql<boolean>`payload->>'clipCandidateId' = ${String(clipCandidateId)}`,
      sql<boolean>`coalesce(payload->>'generationRunId', '') = ${generationRunId}`,
      sql<boolean>`attempt_count > 0`,
      sql<boolean>`started_at is not null`
    ),
    orderBy: (jobs, { desc }) => [desc(jobs.completedAt), desc(jobs.updatedAt)],
  });
}

async function getClipCandidateFacecamState(
  executor: DbLike,
  clipCandidateId: number,
  userId: number
) {
  return await executor.query.clipCandidates.findFirst({
    where: and(
      eq(clipCandidates.id, clipCandidateId),
      eq(clipCandidates.userId, userId)
    ),
    columns: {
      generationRunId: true,
      facecamDetectionStatus: true,
    },
  });
}

async function findActivePublishRenderedClipJob(
  executor: DbLike,
  clipPublicationId: number
) {
  return await executor.query.jobs.findFirst({
    where: and(
      eq(jobs.type, JobType.PUBLISH_RENDERED_CLIP),
      inArray(jobs.status, [JobStatus.PENDING, JobStatus.PROCESSING]),
      sql<boolean>`payload->>'clipPublicationId' = ${String(clipPublicationId)}`
    ),
  });
}

async function findProcessingFacecamDetectionJob(
  executor: DbLike,
  clipCandidateId: number,
  generationRunId: string
) {
  return await executor.query.jobs.findFirst({
    where: and(
      eq(jobs.type, JobType.DETECT_CLIP_FACECAM),
      eq(jobs.status, JobStatus.PROCESSING),
      sql<boolean>`payload->>'clipCandidateId' = ${String(clipCandidateId)}`,
      sql<boolean>`coalesce(payload->>'generationRunId', '') = ${generationRunId}`
    ),
  });
}

async function resetFacecamDetectionPending(
  executor: DbLike,
  clipCandidateId: number,
  userId: number
) {
  await executor
    .update(clipEditConfigs)
    .set({
      facecamDetectionId: null,
      facecamDetected: false,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(clipEditConfigs.clipCandidateId, clipCandidateId),
        eq(clipEditConfigs.userId, userId)
      )
    );

  await executor
    .delete(clipCandidateFacecamDetections)
    .where(
      and(
        eq(clipCandidateFacecamDetections.clipCandidateId, clipCandidateId),
        eq(clipCandidateFacecamDetections.userId, userId)
      )
    );

  await executor
    .update(clipCandidates)
    .set({
      facecamDetectionStatus: FacecamDetectionStatus.PENDING,
      facecamDetectionFailureReason: null,
      facecamDetectionDebugReason: null,
      facecamDetectedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(clipCandidates.id, clipCandidateId),
        eq(clipCandidates.userId, userId)
      )
    );
}

export async function cancelSupersededFacecamDetectionJobs(
  clipCandidateId: number,
  generationRunId: string,
  keepJobId: number,
  executor: DbLike = db
) {
  await executor
    .update(jobs)
    .set({
      status: JobStatus.CANCELLED,
      completedAt: new Date(),
      failureReason: buildCancelledReason('superseded_by_completed_detection'),
      failureCode: 'superseded_by_completed_detection',
      failureClass: JobFailureClass.CANCELLED,
      cancellationReason: 'superseded_by_completed_detection',
      cancellationRequestedAt: new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(jobs.type, JobType.DETECT_CLIP_FACECAM),
        inArray(jobs.status, [JobStatus.PENDING, JobStatus.PROCESSING]),
        sql<boolean>`payload->>'clipCandidateId' = ${String(clipCandidateId)}`,
        sql<boolean>`coalesce(payload->>'generationRunId', '') = ${generationRunId}`,
        sql<boolean>`id <> ${keepJobId}`
      )
    );
}

export async function enqueueTranscriptionJob(
  sourceAssetId: number,
  userId: number,
  executor: DbLike = db
) {
  return await withJobEnqueueBarrier(executor, sourceAssetId, userId, async (tx) =>
    await enqueueTranscriptionJobInternal(sourceAssetId, userId, tx)
  );
}

async function enqueueTranscriptionJobInternal(
  sourceAssetId: number,
  userId: number,
  executor: DbLike = db
) {
  const [sourceAsset] = await executor
    .select({
      id: sourceAssets.id,
      assetType: sourceAssets.assetType,
    })
    .from(sourceAssets)
    .where(and(eq(sourceAssets.id, sourceAssetId), eq(sourceAssets.userId, userId)))
    .limit(1);

  if (!sourceAsset) {
    throw new Error('Source asset not found.');
  }

  if (sourceAsset.assetType !== SourceAssetType.UPLOADED_FILE) {
    return null;
  }

  const payload: TranscribeSourceAssetJobPayload = {
    sourceAssetId,
    userId,
  };

  const transcript = await ensurePendingTranscript(executor, payload);

  if (transcript.status === TranscriptStatus.READY) {
    return null;
  }

  const existingJob = await findActiveSourceAssetJob(
    executor,
    JobType.TRANSCRIBE_SOURCE_ASSET,
    sourceAssetId
  );

  if (existingJob) {
    return existingJob;
  }

  const job = await insertOrReuseJob(executor, {
    type: JobType.TRANSCRIBE_SOURCE_ASSET,
    idempotencyKey: buildJobIdempotencyKey(
      JobType.TRANSCRIBE_SOURCE_ASSET,
      payload
    ),
    status: JobStatus.PENDING,
    payload,
  });

  return job;
}

export async function enqueueSourceAssetThumbnailJob(
  sourceAssetId: number,
  userId: number,
  executor: DbLike = db
) {
  return await withJobEnqueueBarrier(executor, sourceAssetId, userId, async (tx) => {
    const payload: ExtractSourceAssetThumbnailJobPayload = { sourceAssetId, userId };
    return await insertOrReuseJob(tx, {
      type: JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL,
      idempotencyKey: buildJobIdempotencyKey(
        JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL,
        payload
      ),
      status: JobStatus.PENDING,
      payload,
    });
  });
}

export async function recoverStalledTranscriptionJobsForUser(
  userId: number,
  now: Date = new Date()
) {
  const candidates = await db.query.sourceAssets.findMany({
    where: and(
      eq(sourceAssets.userId, userId),
      eq(sourceAssets.assetType, SourceAssetType.UPLOADED_FILE)
    ),
    with: {
      transcript: true,
    },
  });
  let recoveredCount = 0;

  for (const sourceAsset of candidates) {
    const transcriptStatus =
      sourceAsset.transcript?.status || TranscriptStatus.PENDING;

    if (
      !RECOVERABLE_TRANSCRIPTION_SOURCE_STATUSES.has(sourceAsset.status) ||
      !RECOVERABLE_TRANSCRIPTION_STATUSES.has(transcriptStatus)
    ) {
      continue;
    }

    const existingJob = await findActiveTranscriptionJob(db, sourceAsset.id);

    if (existingJob) {
      continue;
    }

    const completedJob = await findCompletedSourceAssetJob(
      db,
      JobType.TRANSCRIBE_SOURCE_ASSET,
      sourceAsset.id
    );

    if (completedJob) {
      continue;
    }

    const job = await enqueueTranscriptionJob(sourceAsset.id, userId);

    if (job) {
      recoveredCount += 1;
    }
  }

  return recoveredCount;
}

export async function recoverStalledShortFormPackJobsForUser(
  userId: number,
  now: Date = new Date()
) {
  const packs = await db.query.contentPacks.findMany({
    where: and(
      eq(contentPacks.userId, userId),
      eq(contentPacks.kind, ContentPackKind.SHORT_FORM_CLIPS),
      inArray(contentPacks.status, [
        ContentPackStatus.PENDING,
        ContentPackStatus.GENERATING,
      ])
    ),
    columns: {
      id: true,
      status: true,
      sourceAssetId: true,
      transcriptId: true,
      generationRunId: true,
    },
    with: {
      sourceAsset: {
        columns: {
          assetType: true,
        },
      },
      clipCandidates: {
        columns: {
          id: true,
        },
      },
    },
  });
  let recoveredCount = 0;

  for (const pack of packs) {
    const activeJob = await findActiveShortFormPipelineJob(db, pack.id);

    if (activeJob) {
      continue;
    }

    const completedJob = await findCompletedShortFormJob(db, pack.id);

    if (!completedJob) {
      await db
        .update(contentPacks)
        .set({
          status: ContentPackStatus.FAILED,
          failureReason: SHORT_FORM_PACK_STALE_FAILURE_REASON,
          updatedAt: new Date(),
        })
        .where(eq(contentPacks.id, pack.id));
      recoveredCount += 1;
      continue;
    }

    if (pack.sourceAsset.assetType === SourceAssetType.UPLOADED_FILE) {
      if (pack.clipCandidates.length === 0) {
        const hasMissingCandidateCancellation =
          await hasMissingCandidateCancellationForGeneration(
            db,
            pack.id,
            pack.generationRunId
          );
        const completedGenerateJobCount = await countCompletedShortFormJobs(
          db,
          pack.id
        );

        if (
          completedGenerateJobCount <= 1 &&
          shouldRetryEmptyUploadedShortFormPack({
            sourceAssetType: pack.sourceAsset.assetType,
            clipCandidateCount: pack.clipCandidates.length,
            hasCompletedGenerateJob: true,
            hasMissingCandidateCancellation,
          })
        ) {
          await enqueueShortFormPackJob(
            pack.id,
            pack.sourceAssetId,
            pack.transcriptId ?? undefined,
            userId
          );

          console.info('pipeline_job.requeued_empty_pack_recovery', {
            contentPackId: pack.id,
            sourceAssetId: pack.sourceAssetId,
            previousGenerationRunId: pack.generationRunId,
            completedGenerateJobCount,
            queueReason: hasMissingCandidateCancellation
              ? 'missing_candidate_cancellation'
              : 'empty_pack_first_recovery',
          });
        } else {
          await db
            .update(contentPacks)
            .set({
              status: ContentPackStatus.FAILED,
              failureReason: SHORT_FORM_PACK_EMPTY_FAILURE_REASON,
              updatedAt: new Date(),
            })
            .where(eq(contentPacks.id, pack.id));
        }
        recoveredCount += 1;
      }

      continue;
    }

    if (pack.clipCandidates.length > 0) {
      await db
        .update(contentPacks)
        .set({
          status: ContentPackStatus.READY,
          failureReason: null,
          updatedAt: new Date(),
        })
        .where(eq(contentPacks.id, pack.id));
    } else {
      await db
        .update(contentPacks)
        .set({
          status: ContentPackStatus.FAILED,
          failureReason: SHORT_FORM_PACK_EMPTY_FAILURE_REASON,
          updatedAt: new Date(),
        })
        .where(eq(contentPacks.id, pack.id));
    }

    recoveredCount += 1;
  }

  return recoveredCount;
}

export async function recoverStalledFacecamDetectionJobsForUser(
  userId: number,
  now: Date = new Date()
) {
  const activeFacecamJobs = await db.query.jobs.findMany({
    where: and(
      eq(jobs.type, JobType.DETECT_CLIP_FACECAM),
      inArray(jobs.status, [JobStatus.PENDING, JobStatus.PROCESSING]),
      sql<boolean>`payload->>'userId' = ${String(userId)}`
    ),
  });
  let recoveredCount = 0;

  for (const job of activeFacecamJobs) {
    const payload = detectClipFacecamJobPayloadSchema.safeParse(job.payload);

    if (!payload.success) {
      await markJobFailed(job.id, 'Facecam detection job payload is invalid.');
      recoveredCount += 1;
      continue;
    }

    const [sourceAsset] = await db
      .select({ id: sourceAssets.id })
      .from(sourceAssets)
      .where(
        and(
          eq(sourceAssets.id, payload.data.sourceAssetId),
          eq(sourceAssets.userId, userId)
        )
      )
      .limit(1);

    if (!sourceAsset) {
      await markJobCancelled(
        job.id,
        'source_asset_deleted'
      );
      recoveredCount += 1;
      continue;
    }

    // Processing jobs are reclaimed only after their database lease expires.
  }

  return recoveredCount;
}

export async function recoverStalledPipelineJobs(now: Date = new Date()) {
  const activeUsers = await db
    .select({ id: users.id })
    .from(users);
  let recoveredCount = 0;

  for (const user of activeUsers) {
    recoveredCount += await recoverStalledTranscriptionJobsForUser(user.id, now);
    recoveredCount += await recoverStalledFacecamDetectionJobsForUser(user.id, now);
    recoveredCount += await recoverStalledShortFormPackJobsForUser(user.id, now);
  }

  return recoveredCount;
}

export async function enqueueYoutubeIngestionJob(
  sourceAssetId: number,
  userId: number,
  executor: DbLike = db
) {
  return await withJobEnqueueBarrier(executor, sourceAssetId, userId, async (tx) =>
    await enqueueYoutubeIngestionJobInternal(sourceAssetId, userId, tx)
  );
}

async function enqueueYoutubeIngestionJobInternal(
  sourceAssetId: number,
  userId: number,
  executor: DbLike = db
) {
  const [sourceAsset] = await executor
    .select({
      id: sourceAssets.id,
      assetType: sourceAssets.assetType,
    })
    .from(sourceAssets)
    .where(and(eq(sourceAssets.id, sourceAssetId), eq(sourceAssets.userId, userId)))
    .limit(1);

  if (!sourceAsset) {
    throw new Error('Source asset not found.');
  }

  if (sourceAsset.assetType !== SourceAssetType.YOUTUBE_URL) {
    return null;
  }

  const payload: IngestYoutubeSourceAssetJobPayload = {
    sourceAssetId,
    userId,
  };

  await ensurePendingTranscript(executor, payload);

  const existingJob = await findActiveSourceAssetJob(
    executor,
    JobType.INGEST_YOUTUBE_SOURCE_ASSET,
    sourceAssetId
  );

  if (existingJob) {
    return existingJob;
  }

  const job = await insertOrReuseJob(executor, {
    type: JobType.INGEST_YOUTUBE_SOURCE_ASSET,
    idempotencyKey: buildJobIdempotencyKey(
      JobType.INGEST_YOUTUBE_SOURCE_ASSET,
      payload
    ),
    status: JobStatus.PENDING,
    payload,
  });

  return job;
}

export async function enqueueShortFormPackJob(
  contentPackId: number,
  sourceAssetId: number,
  transcriptId: number | undefined,
  userId: number,
  brandTemplateId?: number,
  executor: DbLike = db,
  preservedJobId?: number
) {
  return await withJobEnqueueBarrier(executor, sourceAssetId, userId, async (tx) =>
    await enqueueShortFormPackJobInternal(
      contentPackId,
      sourceAssetId,
      transcriptId,
      userId,
      brandTemplateId,
      tx,
      preservedJobId
    )
  );
}

async function enqueueShortFormPackJobInternal(
  contentPackId: number,
  sourceAssetId: number,
  transcriptId: number | undefined,
  userId: number,
  brandTemplateId?: number,
  executor: DbLike = db,
  preservedJobId?: number
) {
  const [contentPack] = await executor
    .select({
      id: contentPacks.id,
      kind: contentPacks.kind,
      status: contentPacks.status,
      generationRunId: contentPacks.generationRunId,
    })
    .from(contentPacks)
    .where(and(eq(contentPacks.id, contentPackId), eq(contentPacks.userId, userId)))
    .limit(1);

  if (!contentPack) {
    throw new Error('Content pack not found.');
  }

  if (contentPack.kind !== ContentPackKind.SHORT_FORM_CLIPS) {
    throw new Error('Only short-form clip packs can be queued for generation.');
  }

  await cancelShortFormPipelineJobsForContentPack(
    contentPackId,
    'generation_run_stale',
    contentPack.generationRunId,
    'eq',
    executor,
    preservedJobId
  );
  const generationRunId = createGenerationRunId();

  await executor
    .update(contentPacks)
    .set({
      status: ContentPackStatus.PENDING,
      ...(transcriptId ? { transcriptId } : {}),
      generationRunId,
      failureReason: null,
      updatedAt: new Date(),
    })
    .where(eq(contentPacks.id, contentPackId));

  const payload: GenerateShortFormPackJobPayload = {
    contentPackId,
    sourceAssetId,
    userId,
    generationRunId,
    ...(transcriptId ? { transcriptId } : {}),
    ...(brandTemplateId ? { brandTemplateId } : {}),
  };

  const job = await insertOrReuseJob(executor, {
    type: JobType.GENERATE_SHORT_FORM_PACK,
    idempotencyKey: buildJobIdempotencyKey(
      JobType.GENERATE_SHORT_FORM_PACK,
      payload
    ),
    status: JobStatus.PENDING,
    payload,
  });

  return job;
}

export async function enqueueRenderClipJob(
  clipCandidateId: number,
  contentPackId: number,
  sourceAssetId: number,
  userId: number,
  captionsEnabled = true,
  captionFontAssetId?: number,
  executor: DbLike = db
) {
  return await withJobEnqueueBarrier(executor, sourceAssetId, userId, async (tx) =>
    await enqueueRenderClipJobInternal(
      clipCandidateId,
      contentPackId,
      sourceAssetId,
      userId,
      captionsEnabled,
      captionFontAssetId,
      tx
    )
  );
}

async function enqueueRenderClipJobInternal(
  clipCandidateId: number,
  contentPackId: number,
  sourceAssetId: number,
  userId: number,
  captionsEnabled = true,
  captionFontAssetId?: number,
  executor: DbLike = db
) {
  const candidate = await assertClipCandidateCanQueueRender(executor, clipCandidateId);

  const existingJob = await findActiveRenderJobByType(
    executor,
    JobType.RENDER_CLIP_CANDIDATE,
    clipCandidateId
  );

  if (existingJob) {
    return existingJob;
  }

  const payload: RenderClipCandidateJobPayload = {
    clipCandidateId,
    contentPackId,
    sourceAssetId,
    userId,
    generationRunId: candidate.generationRunId,
    captionsEnabled,
    captionFontAssetId,
  };

  const job = await insertOrReuseJob(executor, {
    type: JobType.RENDER_CLIP_CANDIDATE,
    idempotencyKey: buildJobIdempotencyKey(
      JobType.RENDER_CLIP_CANDIDATE,
      payload
    ),
    status: JobStatus.PENDING,
    payload,
  });

  console.info('render_queued', {
    clipCandidateId,
    contentPackId,
    sourceAssetId,
    userId,
    generationRunId: candidate.generationRunId,
    jobId: job.id,
    variant: RenderedClipVariant.TRIMMED_ORIGINAL,
    layout: RenderedClipLayout.DEFAULT,
    queueReason: 'render_clip_candidate',
  });

  return job;
}

export async function enqueueFormatRenderedClipShortFormJob(
  clipCandidateId: number,
  contentPackId: number,
  sourceAssetId: number,
  userId: number,
  generationRunId: string,
  variant: RenderedClipVariant = RenderedClipVariant.VERTICAL_SHORT_FORM,
  layout: RenderedClipLayout = RenderedClipLayout.DEFAULT,
  captionsEnabled = true,
  captionFontAssetId?: number,
  editConfigHash?: string,
  renderConfigId?: number,
  skipFacecamRenderGate = false,
  queueReason = 'format_short_form',
  executor: DbLike = db
) {
  return await withJobEnqueueBarrier(executor, sourceAssetId, userId, async (tx) =>
    await enqueueFormatRenderedClipShortFormJobInternal(
      clipCandidateId,
      contentPackId,
      sourceAssetId,
      userId,
      generationRunId,
      variant,
      layout,
      captionsEnabled,
      captionFontAssetId,
      editConfigHash,
      renderConfigId,
      skipFacecamRenderGate,
      queueReason,
      tx
    )
  );
}

async function enqueueFormatRenderedClipShortFormJobInternal(
  clipCandidateId: number,
  contentPackId: number,
  sourceAssetId: number,
  userId: number,
  generationRunId: string,
  variant: RenderedClipVariant = RenderedClipVariant.VERTICAL_SHORT_FORM,
  layout: RenderedClipLayout = RenderedClipLayout.DEFAULT,
  captionsEnabled = true,
  captionFontAssetId?: number,
  editConfigHash?: string,
  renderConfigId?: number,
  skipFacecamRenderGate = false,
  queueReason = 'format_short_form',
  executor: DbLike = db
) {
  if (!skipFacecamRenderGate) {
    await assertClipCandidateCanQueueRender(executor, clipCandidateId);
  }

  const editConfigId = renderConfigId ? undefined : (await executor.query.clipEditConfigs.findFirst({
    where: and(
      eq(clipEditConfigs.clipCandidateId, clipCandidateId),
      eq(clipEditConfigs.generationRunId, generationRunId),
      editConfigHash ? eq(clipEditConfigs.configHash, editConfigHash) : undefined
    ),
  }))?.id;
  if (!renderConfigId && !editConfigId) {
    throw new Error('Exact edit config identity is required to enqueue a format render.');
  }

  const currentRenderedClip = await findCurrentRenderedClipForConfig(
    executor,
    clipCandidateId,
    variant,
    layout,
    editConfigHash,
    generationRunId,
    renderConfigId,
    editConfigId
  );

  if (currentRenderedClip) {
    console.info('render_job.reuse_rendered_clip', {
      clipCandidateId,
      editConfigHash,
      renderedClipId: currentRenderedClip.id,
      renderStatus: currentRenderedClip.status,
      generationRunId,
      queueReason,
    });
    return null;
  }

  const existingJob = await findActiveFormatRenderJob(
    executor,
    clipCandidateId,
    contentPackId,
    sourceAssetId,
    userId,
    variant,
    layout,
    editConfigHash,
    generationRunId,
    renderConfigId,
    editConfigId
  );

  if (existingJob) {
    console.info('render_job.reuse_active_job', {
      clipCandidateId,
      editConfigHash,
      jobId: existingJob.id,
      jobStatus: existingJob.status,
      generationRunId,
      queueReason,
    });
    return existingJob;
  }

  const payload: FormatRenderedClipShortFormJobPayload = {
    clipCandidateId,
    contentPackId,
    sourceAssetId,
    userId,
    generationRunId,
    renderConfigId,
    editConfigId,
    variant,
    layout,
    captionsEnabled,
    captionFontAssetId,
    editConfigHash,
  };

  const job = await insertOrReuseJob(executor, {
    type: JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
    idempotencyKey: buildJobIdempotencyKey(
      JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
      payload
    ),
    status: JobStatus.PENDING,
    payload,
  });

  console.info('render_queued', {
    clipCandidateId,
    contentPackId,
    sourceAssetId,
    userId,
    generationRunId,
    editConfigHash,
    jobId: job.id,
    variant,
    layout,
    queueReason,
  });

  return job;
}

export async function enqueueDetectCandidateFacecamJob(
  candidate: {
    id: number;
    userId: number;
    contentPackId: number;
    sourceAssetId: number;
    generationRunId: string;
    startTimeMs: number;
    endTimeMs: number;
  },
  detectorVersion: string = FACECAM_DETECTOR_VERSION,
  executor: DbLike = db
): Promise<FacecamDetectionEnqueueResult> {
  return await withJobEnqueueBarrier(
    executor,
    candidate.sourceAssetId,
    candidate.userId,
    async (tx) =>
      await enqueueDetectCandidateFacecamJobInternal(candidate, detectorVersion, tx)
  );
}

async function enqueueDetectCandidateFacecamJobInternal(
  candidate: {
    id: number;
    userId: number;
    contentPackId: number;
    sourceAssetId: number;
    generationRunId: string;
    startTimeMs: number;
    endTimeMs: number;
  },
  detectorVersion: string = FACECAM_DETECTOR_VERSION,
  executor: DbLike = db
): Promise<FacecamDetectionEnqueueResult> {
  const clipCandidate = await executor.query.clipCandidates.findFirst({
    where: and(
      eq(clipCandidates.id, candidate.id),
      eq(clipCandidates.userId, candidate.userId)
    ),
    with: {
      sourceAsset: true,
    },
  });

  if (!clipCandidate) {
    throw new Error('Clip candidate not found.');
  }

  if (
    clipCandidate.sourceAsset.assetType !== SourceAssetType.UPLOADED_FILE ||
    (clipCandidate.sourceAsset.mimeType &&
      !clipCandidate.sourceAsset.mimeType.startsWith('video/'))
  ) {
    throw new Error('Facecam detection is only supported for uploaded videos right now.');
  }

  const [insertedRun] = await executor
    .insert(clipCandidateFacecamDetectionRuns)
    .values({
      userId: candidate.userId,
      sourceAssetId: candidate.sourceAssetId,
      contentPackId: candidate.contentPackId,
      clipCandidateId: candidate.id,
      generationRunId: candidate.generationRunId,
      detectorVersion,
      startTimeMs: candidate.startTimeMs,
      endTimeMs: candidate.endTimeMs,
      status: FacecamDetectionStatus.PENDING,
    })
    .onConflictDoNothing({
      target: [
        clipCandidateFacecamDetectionRuns.sourceAssetId,
        clipCandidateFacecamDetectionRuns.clipCandidateId,
        clipCandidateFacecamDetectionRuns.generationRunId,
        clipCandidateFacecamDetectionRuns.startTimeMs,
        clipCandidateFacecamDetectionRuns.endTimeMs,
        clipCandidateFacecamDetectionRuns.detectorVersion,
      ],
    })
    .returning();
  const detectionRun =
    insertedRun ||
    (await executor.query.clipCandidateFacecamDetectionRuns.findFirst({
      where: and(
        eq(clipCandidateFacecamDetectionRuns.sourceAssetId, candidate.sourceAssetId),
        eq(clipCandidateFacecamDetectionRuns.clipCandidateId, candidate.id),
        eq(clipCandidateFacecamDetectionRuns.generationRunId, candidate.generationRunId),
        eq(clipCandidateFacecamDetectionRuns.startTimeMs, candidate.startTimeMs),
        eq(clipCandidateFacecamDetectionRuns.endTimeMs, candidate.endTimeMs),
        eq(clipCandidateFacecamDetectionRuns.detectorVersion, detectorVersion)
      ),
    }));

  if (!detectionRun) {
    throw new Error('Facecam detection run could not be created.');
  }

  const idempotencyKey = buildCandidateFacecamIdempotencyKey({
    sourceAssetId: candidate.sourceAssetId,
    clipCandidateId: candidate.id,
    startTimeMs: candidate.startTimeMs,
    endTimeMs: candidate.endTimeMs,
    detectorVersion,
  });
  const existingJob = await executor.query.jobs.findFirst({
    where: eq(jobs.idempotencyKey, idempotencyKey),
    orderBy: (jobs, { desc }) => [desc(jobs.createdAt)],
  });

  if (existingJob) {
    const status =
      existingJob.status === JobStatus.PROCESSING
        ? 'reused_processing'
        : existingJob.status === JobStatus.PENDING
          ? 'reused_pending'
          : 'reused_completed';

    console.info('candidate_facecam_job.reuse_existing', {
      sourceAssetId: candidate.sourceAssetId,
      contentPackId: candidate.contentPackId,
      clipCandidateId: candidate.id,
      detectionRunId: detectionRun.id,
      detectorVersion,
      jobId: existingJob.id,
      jobStatus: existingJob.status,
      idempotencyKey,
    });

    return {
      job: existingJob,
      status,
    };
  }

  const payload: DetectClipFacecamJobPayload = {
    sourceAssetId: candidate.sourceAssetId,
    userId: candidate.userId,
    contentPackId: candidate.contentPackId,
    clipCandidateId: candidate.id,
    generationRunId: candidate.generationRunId,
    startTimeMs: candidate.startTimeMs,
    endTimeMs: candidate.endTimeMs,
    detectorVersion,
    detectionRunId: detectionRun.id,
  };
  const [job] = await executor
    .insert(jobs)
    .values({
      type: JobType.DETECT_CLIP_FACECAM,
      status: JobStatus.PENDING,
      idempotencyKey,
      payload,
    })
    .onConflictDoNothing({
      target: jobs.idempotencyKey,
    })
    .returning();
  const queuedJob =
    job ||
    (await executor.query.jobs.findFirst({
      where: eq(jobs.idempotencyKey, idempotencyKey),
    }));

  if (!queuedJob) {
    throw new Error('Facecam detection job could not be queued.');
  }

  await executor
    .update(clipCandidateFacecamDetectionRuns)
    .set({
      jobId: queuedJob.id,
      updatedAt: new Date(),
    })
    .where(eq(clipCandidateFacecamDetectionRuns.id, detectionRun.id));

  await executor
    .update(clipCandidates)
    .set({
      facecamDetectionStatus: FacecamDetectionStatus.PENDING,
      facecamDetectionFailureReason: null,
      facecamDetectionDebugReason: null,
      facecamDetectedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(clipCandidates.id, candidate.id),
        eq(clipCandidates.userId, candidate.userId)
      )
    );

  console.info('candidate_facecam_job.queued', {
    sourceAssetId: candidate.sourceAssetId,
    contentPackId: candidate.contentPackId,
    clipCandidateId: candidate.id,
    detectionRunId: detectionRun.id,
    detectorVersion,
    jobId: queuedJob.id,
    idempotencyKey,
  });

  return {
    job: queuedJob,
    status: job ? 'created_pending' : 'reused_pending',
  };
}

export async function enqueueDetectVideoFacecamJob(
  videoId: number,
  userId: number,
  contentPackId?: number,
  generationRunId?: string,
  executor: DbLike = db
): Promise<FacecamDetectionEnqueueResult> {
  return await withJobEnqueueBarrier(executor, videoId, userId, async (tx) =>
    await enqueueDetectVideoFacecamJobInternal(
      videoId,
      userId,
      contentPackId,
      generationRunId,
      tx
    )
  );
}

async function enqueueDetectVideoFacecamJobInternal(
  videoId: number,
  userId: number,
  contentPackId?: number,
  generationRunId?: string,
  executor: DbLike = db
): Promise<FacecamDetectionEnqueueResult> {
  const [sourceAsset] = await executor
    .select({
      id: sourceAssets.id,
      userId: sourceAssets.userId,
      assetType: sourceAssets.assetType,
      mimeType: sourceAssets.mimeType,
    })
    .from(sourceAssets)
    .where(and(eq(sourceAssets.id, videoId), eq(sourceAssets.userId, userId)))
    .limit(1);

  if (!sourceAsset) {
    throw new Error('Source video not found.');
  }

  if (
    sourceAsset.assetType !== SourceAssetType.UPLOADED_FILE ||
    (sourceAsset.mimeType && !sourceAsset.mimeType.startsWith('video/'))
  ) {
    throw new Error('Facecam detection is only supported for uploaded videos right now.');
  }

  const idempotencyKey = buildFacecamIdempotencyKey(videoId);
  const existingJob = await executor.query.jobs.findFirst({
    where: eq(jobs.idempotencyKey, idempotencyKey),
    orderBy: (jobs, { desc }) => [desc(jobs.createdAt)],
  });

  if (existingJob) {
    const status =
      existingJob.status === JobStatus.COMPLETED ||
      existingJob.status === JobStatus.CANCELLED ||
      existingJob.status === JobStatus.FAILED
        ? 'reused_completed'
        : existingJob.status === JobStatus.PROCESSING
          ? 'reused_processing'
          : 'reused_pending';

    console.info('facecam_job.reuse_existing', {
      videoId,
      userId,
      contentPackId: contentPackId ?? null,
      jobId: existingJob.id,
      jobStatus: existingJob.status,
      idempotencyKey,
    });

    return {
      job: existingJob,
      status,
    };
  }

  const payload: DetectClipFacecamJobPayload = {
    videoId,
    sourceAssetId: videoId,
    userId,
    ...(contentPackId ? { contentPackId } : {}),
    ...(generationRunId ? { generationRunId } : {}),
  };

  const [job] = await executor
    .insert(jobs)
    .values({
      type: JobType.DETECT_CLIP_FACECAM,
      status: JobStatus.PENDING,
      idempotencyKey,
      payload,
    })
    .onConflictDoNothing({
      target: jobs.idempotencyKey,
    })
    .returning();

  if (job) {
    return {
      job,
      status: 'created_pending',
    };
  }

  const reusedJob = await executor.query.jobs.findFirst({
    where: eq(jobs.idempotencyKey, idempotencyKey),
  });

  if (!reusedJob) {
    throw new Error('Facecam detection job could not be queued.');
  }

  console.info('facecam_job.reuse_existing', {
    videoId,
    userId,
    contentPackId: contentPackId ?? null,
    jobId: reusedJob.id,
    jobStatus: reusedJob.status,
    idempotencyKey,
  });

  return {
    job: reusedJob,
    status:
      reusedJob.status === JobStatus.PROCESSING
        ? 'reused_processing'
        : reusedJob.status === JobStatus.PENDING
          ? 'reused_pending'
          : 'reused_completed',
  };
}

export async function enqueuePublishRenderedClipJob(
  clipPublicationId: number,
  renderedClipId: number,
  linkedAccountId: number,
  userId: number,
  platform: 'youtube' | 'tiktok',
  executor: DbLike = db
) {
  assertDirectPublishingProhibited();
  const [renderedClip] = await executor
    .select({ sourceAssetId: renderedClips.sourceAssetId })
    .from(renderedClips)
    .where(and(eq(renderedClips.id, renderedClipId), eq(renderedClips.userId, userId)))
    .limit(1);

  if (!renderedClip) {
    throw new Error('Rendered clip not found.');
  }

  return await withJobEnqueueBarrier(
    executor,
    renderedClip.sourceAssetId,
    userId,
    async (tx) =>
      await enqueuePublishRenderedClipJobInternal(
        clipPublicationId,
        renderedClipId,
        linkedAccountId,
        userId,
        platform,
        tx
      )
  );
}

async function enqueuePublishRenderedClipJobInternal(
  clipPublicationId: number,
  renderedClipId: number,
  linkedAccountId: number,
  userId: number,
  platform: 'youtube' | 'tiktok',
  executor: DbLike = db
) {
  assertDirectPublishingProhibited();
  const existingJob = await findActivePublishRenderedClipJob(
    executor,
    clipPublicationId
  );

  if (existingJob) {
    return existingJob;
  }

  const payload: PublishRenderedClipJobPayload = {
    clipPublicationId,
    renderedClipId,
    linkedAccountId,
    userId,
    platform,
  };

  const job = await insertOrReuseJob(executor, {
    type: JobType.PUBLISH_RENDERED_CLIP,
    idempotencyKey: buildJobIdempotencyKey(
      JobType.PUBLISH_RENDERED_CLIP,
      payload
    ),
    status: JobStatus.PENDING,
    payload,
  });

  return job;
}

function parseJobPayload(type: JobType, payload: JobPayload) {
  switch (type) {
    case JobType.TRANSCRIBE_SOURCE_ASSET: {
      const parsed = transcribeSourceAssetJobPayloadSchema.safeParse(payload);

      if (!parsed.success) {
        throw new Error('Claimed transcription job payload is invalid.');
      }

      return parsed.data;
    }
    case JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL: {
      const parsed = extractSourceAssetThumbnailJobPayloadSchema.safeParse(payload);

      if (!parsed.success) {
        throw new Error('Claimed thumbnail extraction job payload is invalid.');
      }

      return parsed.data;
    }
    case JobType.INGEST_YOUTUBE_SOURCE_ASSET: {
      const parsed = ingestYoutubeSourceAssetJobPayloadSchema.safeParse(payload);

      if (!parsed.success) {
        throw new Error('Claimed YouTube ingestion job payload is invalid.');
      }

      return parsed.data;
    }
    case JobType.GENERATE_SHORT_FORM_PACK: {
      const parsed = generateShortFormPackJobPayloadSchema.safeParse(payload);

      if (!parsed.success) {
        throw new Error('Claimed short-form job payload is invalid.');
      }

      return parsed.data;
    }
    case JobType.RENDER_CLIP_CANDIDATE: {
      const parsed = renderClipCandidateJobPayloadSchema.safeParse(payload);

      if (!parsed.success) {
        throw new Error('Claimed render clip job payload is invalid.');
      }

      return parsed.data;
    }
    case JobType.FORMAT_RENDERED_CLIP_SHORT_FORM: {
      const parsed =
        formatRenderedClipShortFormJobPayloadSchema.safeParse(payload);

      if (!parsed.success) {
        throw new Error(
          'Claimed short-form format job payload is invalid.'
        );
      }

      return parsed.data;
    }
    case JobType.DETECT_CLIP_FACECAM: {
      const parsed = detectClipFacecamJobPayloadSchema.safeParse(payload);

      if (!parsed.success) {
        throw new Error(
          'Claimed facecam detection job payload is invalid.'
        );
      }

      return parsed.data;
    }
    case JobType.PUBLISH_RENDERED_CLIP: {
      const parsed = publishRenderedClipJobPayloadSchema.safeParse(payload);

      if (!parsed.success) {
        throw new Error('Claimed clip publish job payload is invalid.');
      }

      return parsed.data;
    }
    default:
      throw new Error('Unsupported job type.');
  }
}

type ClaimNextJobOptions = {
  schedulerOwnerToken?: string;
  recoverExpiredLeases?: boolean;
  allowedJobTypes?: JobType[];
};

export type ClaimNextJobOutcome =
  | { status: 'claimed'; job: ClaimedPipelineJob }
  | { status: 'queue_empty'; dueJobTypes: [] }
  | { status: 'capacity_blocked'; dueJobTypes: JobType[] }
  | { status: 'runtime_ineligible'; dueJobTypes: JobType[] }
  | { status: 'concurrent_claim'; dueJobTypes: JobType[] }
  | { status: 'ownership_lost'; dueJobTypes: [] };

type RecoveryRow = { id: number; status: string };

async function recoverExpiredJobLeases(
  executor: DbTransaction,
  limit: number
) {
  const normalizedLimit = Math.max(1, Math.min(Math.floor(limit), 1_000));
  const recoverable = await executor.select().from(jobs).where(or(
    and(
      eq(jobs.status, JobStatus.PROCESSING),
      or(isNull(jobs.leaseExpiresAt), sql<boolean>`${jobs.leaseExpiresAt} <= clock_timestamp()`),
      sql<boolean>`${jobs.availableAt} <= clock_timestamp()`
    ),
    and(eq(jobs.status, JobStatus.PENDING), sql<boolean>`${jobs.cancellationRequestedAt} is not null`),
    and(eq(jobs.status, JobStatus.PENDING), sql<boolean>`${jobs.attemptCount} >= ${jobs.maxAttempts}`)
  )).orderBy(jobs.id).limit(normalizedLimit).for('update', { skipLocked: true });

  const recovered: RecoveryRow[] = [];
  for (const job of recoverable) {
    let status = JobStatus.FAILED;
    let failureReason = 'Job cannot be recovered safely.';
    let failureCode = 'checkpoint_state_invalid';
    let failureClass = JobFailureClass.AMBIGUOUS_EXTERNAL_EFFECT;
    let maxAttempts = job.maxAttempts;

    if (job.status === JobStatus.PENDING) {
      if (job.cancellationRequestedAt) {
        status = JobStatus.CANCELLED;
        failureReason = `Cancelled: ${job.cancellationReason ?? 'cancellation_requested'}`;
        failureCode = job.cancellationReason ?? 'cancellation_requested';
        failureClass = JobFailureClass.CANCELLED;
      } else {
        failureReason = 'Job lease expired after the maximum number of attempts.';
        failureCode = 'lease_attempts_exhausted';
        failureClass = JobFailureClass.SAFE_NO_EXTERNAL_EFFECT;
      }
    } else {
      const [checkpoint] = await executor.select().from(jobEffectCheckpoints).where(and(
        eq(jobEffectCheckpoints.jobId, job.id),
        eq(jobEffectCheckpoints.effectKey, PRIMARY_JOB_EFFECT_KEY)
      )).for('update').limit(1);
      const checkpointTypeMatches = checkpoint?.jobType === job.type;
      const checkpointType = Object.values(JobType).includes(job.type as JobType)
        ? job.type as JobType
        : null;

      if (job.cancellationRequestedAt) {
        status = JobStatus.CANCELLED;
        failureReason = `Cancelled: ${job.cancellationReason ?? 'cancellation_requested'}`;
        failureCode = job.cancellationReason ?? 'cancellation_requested';
        failureClass = JobFailureClass.CANCELLED;
      } else if (!checkpoint) {
        failureReason = 'Expired lease has no trustworthy external-effect checkpoint.';
        failureCode = 'checkpoint_state_missing';
      } else if (!checkpointTypeMatches || !checkpointType) {
        failureReason = 'Expired lease has a mismatched external-effect checkpoint.';
      } else if (checkpoint.status === JobEffectCheckpointStatus.EXTERNAL_EFFECT_STARTED) {
        failureReason = 'External effect may have started before the worker lease expired.';
        failureCode = 'external_effect_ambiguous';
      } else if (checkpoint.status === JobEffectCheckpointStatus.COMPLETED) {
        const parsed = checkpoint.result
          ? parseJobEffectCheckpointResult(checkpointType, checkpoint.result)
          : null;
        if (parsed) {
          status = JobStatus.PENDING;
          failureReason = 'Completed external-effect checkpoint is ready for projection replay.';
          failureCode = 'durable_checkpoint_replay';
          failureClass = JobFailureClass.DURABLE_CHECKPOINT;
          maxAttempts = Math.max(job.maxAttempts, job.attemptCount + 1);
        } else {
          failureReason = 'Expired lease has a malformed completed checkpoint.';
        }
      } else if (
        checkpoint.status === JobEffectCheckpointStatus.PREPARED &&
        checkpoint.result === null &&
        checkpoint.externalEffectStartedAt === null &&
        checkpoint.completedAt === null
      ) {
        if (job.attemptCount >= job.maxAttempts) {
          failureReason = 'Prepared external effect exhausted the maximum number of attempts.';
          failureCode = 'lease_attempts_exhausted';
          failureClass = JobFailureClass.SAFE_NO_EXTERNAL_EFFECT;
        } else {
          status = JobStatus.PENDING;
          failureReason = 'Previous worker lease expired before the external effect started.';
          failureCode = 'lease_expired_reclaimed';
          failureClass = JobFailureClass.SAFE_NO_EXTERNAL_EFFECT;
        }
      }
    }

    const now = sql<Date>`clock_timestamp()`;
    const [updated] = await executor.update(jobs).set({
      status,
      availableAt: status === JobStatus.PENDING ? now : job.availableAt,
      startedAt: status === JobStatus.PENDING ? null : job.startedAt,
      completedAt: status === JobStatus.PENDING ? null : now,
      failureReason,
      failureCode,
      failureClass,
      maxAttempts,
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: now,
      updatedAt: now,
    }).where(eq(jobs.id, job.id)).returning({ id: jobs.id, status: jobs.status });
    if (updated) recovered.push(updated);
  }
  return recovered;
}

export async function recoverExpiredPipelineJobLeases(
  limit = 100,
  schedulerOwnerToken?: string
) {
  return await db.transaction(async (tx) => {
    if (schedulerOwnerToken) {
      const [state] = await tx.select({
        ownerToken: pipelineSchedulerState.ownerToken,
        leaseIsValid: sql<boolean>`${pipelineSchedulerState.leaseExpiresAt} > clock_timestamp()`,
      }).from(pipelineSchedulerState)
        .where(eq(pipelineSchedulerState.id, 1))
        .for('update')
        .limit(1);
      if (state?.ownerToken !== schedulerOwnerToken || !state.leaseIsValid) {
        return 0;
      }
    }
    return (await recoverExpiredJobLeases(tx, limit)).length;
  });
}

export async function claimNextJobWithOutcome(
  options: ClaimNextJobOptions = {}
): Promise<ClaimNextJobOutcome> {
  return await db.transaction(async (tx) => {
    const now = sql<Date>`clock_timestamp()`;
    await tx.insert(pipelineSchedulerState).values({ id: 1 })
      .onConflictDoNothing({ target: pipelineSchedulerState.id });
    const [schedulerState] = await tx.select({
      ownerToken: pipelineSchedulerState.ownerToken,
      leaseIsValid: sql<boolean>`${pipelineSchedulerState.leaseExpiresAt} > clock_timestamp()`,
    }).from(pipelineSchedulerState)
      .where(eq(pipelineSchedulerState.id, 1))
      .for('update')
      .limit(1);
    if (
      options.schedulerOwnerToken &&
      (
        schedulerState?.ownerToken !== options.schedulerOwnerToken ||
        !schedulerState.leaseIsValid
      )
    ) {
      return { status: 'ownership_lost', dueJobTypes: [] };
    }
    if (options.recoverExpiredLeases !== false) {
      await recoverExpiredJobLeases(tx, 100);
    }
    const maxRenderConcurrency = getMaxRenderConcurrency();
    const maxFacecamConcurrency = getMaxFacecamConcurrency();
    const allowedTypesFilter = options.allowedJobTypes
      ? options.allowedJobTypes.length > 0
        ? sql`and "jobs"."type" in (${sql.join(
            options.allowedJobTypes.map((type) => sql`${type}`),
            sql`, `
          )})`
        : sql`and false`
      : sql``;
    const rows = await tx.execute<{ id: number }>(sql`
      select "jobs"."id"
      from "jobs"
      where "jobs"."status" = ${JobStatus.PENDING}
        and "jobs"."cancellation_requested_at" is null
        and "jobs"."available_at" <= clock_timestamp()
        ${allowedTypesFilter}
        and (
          "jobs"."type" not in (
            ${JobType.RENDER_CLIP_CANDIDATE},
            ${JobType.FORMAT_RENDERED_CLIP_SHORT_FORM},
            ${JobType.DETECT_CLIP_FACECAM}
          )
          or (
            "jobs"."type" in (${JobType.RENDER_CLIP_CANDIDATE}, ${JobType.FORMAT_RENDERED_CLIP_SHORT_FORM})
            and (
              select count(*)
              from "jobs" active_render_jobs
              where active_render_jobs."status" = ${JobStatus.PROCESSING}
                and active_render_jobs."type" in (${JobType.RENDER_CLIP_CANDIDATE}, ${JobType.FORMAT_RENDERED_CLIP_SHORT_FORM})
            ) < ${maxRenderConcurrency}
          )
          or (
            "jobs"."type" = ${JobType.DETECT_CLIP_FACECAM}
            and (
              select count(*)
              from "jobs" active_facecam_jobs
              where active_facecam_jobs."status" = ${JobStatus.PROCESSING}
                and active_facecam_jobs."type" = ${JobType.DETECT_CLIP_FACECAM}
            ) < ${maxFacecamConcurrency}
          )
        )
      order by
        "jobs"."available_at" asc,
        case
          when "jobs"."type" in (${JobType.RENDER_CLIP_CANDIDATE}, ${JobType.FORMAT_RENDERED_CLIP_SHORT_FORM})
            then (
              select render_candidates."rank"
              from "clip_candidates" render_candidates
              where render_candidates."id" = nullif("jobs"."payload"->>'clipCandidateId', '')::int
              limit 1
            )
          else null
        end asc nulls last,
        case
          when "jobs"."type" in (${JobType.RENDER_CLIP_CANDIDATE}, ${JobType.FORMAT_RENDERED_CLIP_SHORT_FORM})
            then (
              select render_candidates."created_at"
              from "clip_candidates" render_candidates
              where render_candidates."id" = nullif("jobs"."payload"->>'clipCandidateId', '')::int
              limit 1
            )
          else null
        end asc nulls last,
        "jobs"."created_at" asc
      limit 1
      for update skip locked
    `);
    const nextJobId = rows[0]?.id;

    if (!nextJobId) {
      const dueRows = await tx.select({ type: jobs.type }).from(jobs).where(and(
        eq(jobs.status, JobStatus.PENDING),
        isNull(jobs.cancellationRequestedAt),
        sql<boolean>`${jobs.availableAt} <= clock_timestamp()`,
        sql<boolean>`${jobs.attemptCount} < ${jobs.maxAttempts}`
      ));
      const dueJobTypes = [...new Set(
        dueRows
          .map((row) => row.type as JobType)
          .filter((type) => Object.values(JobType).includes(type))
      )];
      if (dueJobTypes.length === 0) {
        return { status: 'queue_empty', dueJobTypes: [] };
      }
      const allowedDueJobTypes = options.allowedJobTypes
        ? dueJobTypes.filter((type) => options.allowedJobTypes!.includes(type))
        : dueJobTypes;
      if (allowedDueJobTypes.length === 0) {
        return { status: 'runtime_ineligible', dueJobTypes };
      }

      const capacityRows = await tx.execute<{ claimable: boolean }>(sql`
        select exists (
          select 1 from ${jobs}
          where ${jobs.status} = ${JobStatus.PENDING}
            and ${jobs.cancellationRequestedAt} is null
            and ${jobs.availableAt} <= clock_timestamp()
            and ${jobs.attemptCount} < ${jobs.maxAttempts}
            and ${jobs.type} in (${sql.join(
              allowedDueJobTypes.map((type) => sql`${type}`),
              sql`, `
            )})
            and (
              ${jobs.type} not in (
                ${JobType.RENDER_CLIP_CANDIDATE},
                ${JobType.FORMAT_RENDERED_CLIP_SHORT_FORM},
                ${JobType.DETECT_CLIP_FACECAM}
              )
              or (
                ${jobs.type} in (${JobType.RENDER_CLIP_CANDIDATE}, ${JobType.FORMAT_RENDERED_CLIP_SHORT_FORM})
                and (
                  select count(*) from ${jobs} active_render_jobs
                  where active_render_jobs.status = ${JobStatus.PROCESSING}
                    and active_render_jobs.type in (${JobType.RENDER_CLIP_CANDIDATE}, ${JobType.FORMAT_RENDERED_CLIP_SHORT_FORM})
                ) < ${maxRenderConcurrency}
              )
              or (
                ${jobs.type} = ${JobType.DETECT_CLIP_FACECAM}
                and (
                  select count(*) from ${jobs} active_facecam_jobs
                  where active_facecam_jobs.status = ${JobStatus.PROCESSING}
                    and active_facecam_jobs.type = ${JobType.DETECT_CLIP_FACECAM}
                ) < ${maxFacecamConcurrency}
              )
            )
        ) as claimable
      `);
      return capacityRows[0]?.claimable
        ? { status: 'concurrent_claim', dueJobTypes }
        : { status: 'capacity_blocked', dueJobTypes };
    }

    const leaseToken = randomUUID();
    const [job] = await tx
      .update(jobs)
      .set({
        status: JobStatus.PROCESSING,
        attemptCount: sql`${jobs.attemptCount} + 1`,
        startedAt: now,
        heartbeatAt: now,
        leaseToken,
        leaseExpiresAt:
          sql`clock_timestamp() + (${DEFAULT_JOB_LEASE_MS} * interval '1 millisecond')`,
        failureReason: null,
        failureCode: null,
        failureClass: null,
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, nextJobId))
      .returning();

    if (!job) {
      return {
        status: 'concurrent_claim',
        dueJobTypes: options.allowedJobTypes ?? Object.values(JobType),
      };
    }

    const payload = parseJobPayload(job.type as JobType, job.payload as JobPayload);

    const claimedJob = {
      ...job,
      type: job.type as ClaimedPipelineJob['type'],
      payload,
    } as ClaimedPipelineJob;
    return { status: 'claimed', job: claimedJob };
  });
}

export async function claimNextJob(options: ClaimNextJobOptions = {}) {
  const outcome = await claimNextJobWithOutcome(options);
  return outcome.status === 'claimed' ? outcome.job : null;
}

async function setJobCompleted(
  tx: DbTransaction,
  context: AuthorizedJobContext
) {
  const now = sql<Date>`clock_timestamp()`;
  await tx
    .update(jobs)
    .set({
      status: JobStatus.COMPLETED,
      completedAt: now,
      failureReason: null,
      failureCode: null,
      failureClass: null,
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: now,
      updatedAt: now,
    })
    .where(eq(jobs.id, context.job.id));
}

async function setJobCancelled(
  tx: DbTransaction,
  context: AuthorizedJobContext,
  reason: string | StaleJobReason
) {
  const now = sql<Date>`clock_timestamp()`;
  await tx
    .update(jobs)
    .set({
      status: JobStatus.CANCELLED,
      completedAt: now,
      failureReason: buildCancelledReason(reason),
      failureCode: String(reason),
      failureClass: JobFailureClass.CANCELLED,
      cancellationReason: String(reason),
      cancellationRequestedAt: now,
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: now,
      updatedAt: now,
    })
    .where(eq(jobs.id, context.job.id));
}

export async function withAuthorizedJobCompletion<T>(
  authority: JobExecutionAuthority,
  effect: (tx: DbTransaction, context: AuthorizedJobContext) => Promise<T>
) {
  return await withAuthorizedJobSuccessTransaction(
    authority,
    effect,
    undefined,
    setJobCompleted
  );
}

export async function withAuthorizedJobCancellation<T>(
  authority: JobExecutionAuthority,
  reason: string | StaleJobReason,
  effect: (tx: DbTransaction, context: AuthorizedJobContext) => Promise<T>
) {
  return await withAuthorizedJobTransaction(
    authority,
    effect,
    undefined,
    async (tx, context) => await setJobCancelled(tx, context, reason)
  );
}

export async function withAuthorizedMissingCandidateCancellation<T>(
  authority: JobExecutionAuthority,
  effect: (tx: DbTransaction, context: AuthorizedJobContext) => Promise<T>
) {
  return await withAuthorizedMissingCandidateCancellationTransaction(
    authority,
    effect,
    async (tx, context) =>
      await setJobCancelled(tx, context, StaleJobReason.CLIP_CANDIDATE_MISSING)
  );
}

export async function markJobCompleted(jobId: number, leaseToken: string) {
  try {
    await withAuthorizedJobCompletion(
      { jobId, leaseToken },
      async () => undefined
    );
  } catch (error) {
    if (error instanceof JobExecutionUnauthorizedError) {
      throw new JobLeaseLostError();
    }
    throw error;
  }
}

export async function heartbeatJobLease(jobId: number, leaseToken: string) {
  const [job] = await db
    .update(jobs)
    .set({
      heartbeatAt: sql`clock_timestamp()`,
      leaseExpiresAt:
        sql`clock_timestamp() + (${DEFAULT_JOB_LEASE_MS} * interval '1 millisecond')`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.status, JobStatus.PROCESSING),
        eq(jobs.leaseToken, leaseToken),
        isNull(jobs.cancellationRequestedAt),
        sql<boolean>`${jobs.leaseExpiresAt} > clock_timestamp()`
      )
    )
    .returning({ id: jobs.id });
  return Boolean(job);
}

export async function acknowledgeJobCancellation(
  jobId: number,
  leaseToken: string
) {
  const now = sql<Date>`clock_timestamp()`;
  const [job] = await db
    .update(jobs)
    .set({
      status: JobStatus.CANCELLED,
      completedAt: now,
      failureReason: sql`'Cancelled: ' || coalesce(${jobs.cancellationReason}, 'cancellation_requested')`,
      failureCode: sql`coalesce(${jobs.cancellationReason}, 'cancellation_requested')`,
      failureClass: JobFailureClass.CANCELLED,
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.status, JobStatus.PROCESSING),
        eq(jobs.leaseToken, leaseToken),
        sql<boolean>`${jobs.cancellationRequestedAt} is not null`
      )
    )
    .returning({ id: jobs.id });

  return Boolean(job);
}

export async function markJobCancelled(
  jobId: number,
  reason: string | StaleJobReason,
  leaseToken?: string
) {
  const [job] = await db
    .update(jobs)
    .set({
      status: JobStatus.CANCELLED,
      completedAt: new Date(),
      failureReason: buildCancelledReason(reason),
      failureCode: String(reason),
      failureClass: JobFailureClass.CANCELLED,
      cancellationReason: String(reason),
      cancellationRequestedAt: new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(jobs.id, jobId),
        ...(leaseToken
          ? [
              eq(jobs.status, JobStatus.PROCESSING),
              eq(jobs.leaseToken, leaseToken),
              sql<boolean>`${jobs.leaseExpiresAt} > clock_timestamp()`,
            ]
          : [])
      )
    )
    .returning({ id: jobs.id });
  if (leaseToken && !job) throw new JobLeaseLostError();
}

export async function requeueJob(
  jobId: number,
  leaseToken: string,
  availableAt?: Date,
  executor: DbLike = db
) {
  const [job] = await executor
    .update(jobs)
    .set({
      status: JobStatus.PENDING,
      availableAt: availableAt ?? sql`clock_timestamp()`,
      startedAt: null,
      heartbeatAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
      failureReason: null,
      failureCode: null,
      failureClass: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.status, JobStatus.PROCESSING),
        eq(jobs.leaseToken, leaseToken),
        isNull(jobs.cancellationRequestedAt),
        sql<boolean>`${jobs.leaseExpiresAt} > clock_timestamp()`
      )
    )
    .returning({ id: jobs.id });
  if (!job) {
    throw new JobLeaseLostError();
  }
}

export async function cancelJobsByIds(
  jobIds: number[],
  reason: string | StaleJobReason,
  executor: DbLike = db
) {
  if (jobIds.length === 0) {
    return;
  }

  await executor
    .update(jobs)
    .set({
      status: JobStatus.CANCELLED,
      completedAt: new Date(),
      failureReason: buildCancelledReason(reason),
      failureCode: String(reason),
      failureClass: JobFailureClass.CANCELLED,
      cancellationReason: String(reason),
      cancellationRequestedAt: new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(jobs.id, jobIds),
        inArray(jobs.status, [JobStatus.PENDING, JobStatus.PROCESSING])
      )
    );
}

export async function cancelShortFormPipelineJobsForContentPack(
  contentPackId: number,
  reason: string | StaleJobReason,
  generationRunId?: string,
  generationRunOperator: 'eq' | 'neq' = 'eq',
  executor: DbLike = db,
  preservedJobId?: number
) {
  await executor
    .update(jobs)
    .set({
      status: JobStatus.CANCELLED,
      completedAt: new Date(),
      failureReason: buildCancelledReason(reason),
      failureCode: String(reason),
      failureClass: JobFailureClass.CANCELLED,
      cancellationReason: String(reason),
      cancellationRequestedAt: new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(jobs.type, [
          JobType.GENERATE_SHORT_FORM_PACK,
          JobType.DETECT_CLIP_FACECAM,
          JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
          JobType.RENDER_CLIP_CANDIDATE,
        ]),
        inArray(jobs.status, [JobStatus.PENDING, JobStatus.PROCESSING]),
        sql<boolean>`payload->>'contentPackId' = ${String(contentPackId)}`,
        ...(preservedJobId ? [ne(jobs.id, preservedJobId)] : []),
        ...(generationRunId
          ? [
              generationRunOperator === 'neq'
                ? sql<boolean>`coalesce(payload->>'generationRunId', '') <> ${generationRunId}`
                : sql<boolean>`coalesce(payload->>'generationRunId', '') = ${generationRunId}`,
            ]
          : [])
      )
    );
}

export async function wakeShortFormPackJobsForSourceAsset(
  sourceAssetId: number,
  transcriptId?: number,
  executor: DbLike = db
) {
  await executor
    .update(jobs)
    .set({
      availableAt: new Date(),
      ...(transcriptId
        ? { payload: sql`${jobs.payload} || ${JSON.stringify({ transcriptId })}::jsonb` }
        : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(jobs.type, JobType.GENERATE_SHORT_FORM_PACK),
        eq(jobs.status, JobStatus.PENDING),
        sql<boolean>`payload->>'sourceAssetId' = ${String(sourceAssetId)}`
      )
    );
}

export async function markJobFailed(
  jobId: number,
  reason: string,
  leaseToken?: string,
  classification: { code: string; failureClass: JobFailureClass } = {
    code: 'unclassified_failure',
    failureClass: JobFailureClass.PERMANENT,
  }
) {
  if (leaseToken) {
    try {
      await withAuthorizedJobFailure(
        { jobId, leaseToken },
        reason,
        async () => undefined,
        classification
      );
      return true;
    } catch (error) {
      if (error instanceof JobExecutionUnauthorizedError) {
        return false;
      }
      throw error;
    }
  }

  const now = sql<Date>`clock_timestamp()`;
  const [job] = await db
    .update(jobs)
    .set({
      status: JobStatus.FAILED,
      completedAt: now,
      failureReason: normalizeFailureReason(reason),
      failureCode: classification.code,
      failureClass: classification.failureClass,
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: now,
      updatedAt: now,
    })
    .where(eq(jobs.id, jobId))
    .returning({ id: jobs.id });
  return Boolean(job);
}

export async function withAuthorizedJobFailure<T>(
  authority: JobExecutionAuthority,
  reason: string,
  effect: (tx: DbTransaction, context: AuthorizedJobContext) => Promise<T>,
  classification: { code: string; failureClass: JobFailureClass } = {
    code: 'unclassified_failure',
    failureClass: JobFailureClass.PERMANENT,
  }
) {
  return await withAuthorizedJobTransaction(
    authority,
    effect,
    undefined,
    async (tx, context) => {
      const now = sql<Date>`clock_timestamp()`;
      await tx
        .update(jobs)
        .set({
          status: JobStatus.FAILED,
          completedAt: now,
          failureReason: normalizeFailureReason(reason),
          failureCode: classification.code,
          failureClass: classification.failureClass,
          leaseToken: null,
          leaseExpiresAt: null,
          heartbeatAt: now,
          updatedAt: now,
        })
        .where(eq(jobs.id, context.job.id));
    }
  );
}
