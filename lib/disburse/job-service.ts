import 'server-only';

import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db/drizzle';
import {
  FACECAM_DETECTION_STALE_FAILURE_REASON,
  FACECAM_DETECTION_STALE_MS,
  isStaleFacecamDetectionStartedAt,
} from '@/lib/disburse/facecam-recovery';
import {
  clipCandidateFacecamDetections,
  clipCandidates,
  clipEditConfigs,
  contentPacks,
  ContentPackKind,
  ContentPackStatus,
  FacecamDetectionStatus,
  jobs,
  JobStatus,
  JobType,
  RenderedClipLayout,
  renderedClips,
  RenderedClipStatus,
  RenderedClipVariant,
  sourceAssets,
  SourceAssetStatus,
  SourceAssetType,
  transcripts,
  TranscriptStatus,
  users,
  type DetectClipFacecamJobPayload,
  type PublishRenderedClipJobPayload,
  type GenerateShortFormPackJobPayload,
  type FormatRenderedClipShortFormJobPayload,
  type RenderClipCandidateJobPayload,
  type IngestYoutubeSourceAssetJobPayload,
  type Job,
  type JobPayload,
  type TranscribeSourceAssetJobPayload,
} from '@/lib/db/schema';
import {
  createGenerationRunId,
  isStaleGenerationRun,
} from '@/lib/disburse/generation-run-service';
import { type StaleJobReason } from '@/lib/disburse/stale-job';
import { buildFacecamIdempotencyKey } from '@/lib/disburse/facecam-detection-service';

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
const TRANSCRIPTION_STALE_MS = 10 * 60 * 1000;
const TRANSCRIPTION_STALE_FAILURE_REASON =
  'Transcription worker stalled and the job will be retried automatically.';
const SHORT_FORM_PACK_STALE_MS = 10 * 60 * 1000;
const SHORT_FORM_PACK_STALE_FAILURE_REASON =
  'Clip candidate generation stalled. Please run setup again.';
const SHORT_FORM_PACK_EMPTY_FAILURE_REASON =
  'Clip candidate generation completed without creating usable clips. Please run setup again.';
const DEFAULT_RENDER_CONCURRENCY =
  process.env.NODE_ENV === 'production' ? 1 : 1;
const DEFAULT_FACECAM_CONCURRENCY =
  process.env.NODE_ENV === 'production' ? 1 : 1;

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

const transcribeSourceAssetJobPayloadSchema = z.object({
  sourceAssetId: z.number().int().positive(),
  userId: z.number().int().positive(),
});

const ingestYoutubeSourceAssetJobPayloadSchema = z.object({
  sourceAssetId: z.number().int().positive(),
  userId: z.number().int().positive(),
});

const generateShortFormPackJobPayloadSchema = z.object({
  contentPackId: z.number().int().positive(),
  sourceAssetId: z.number().int().positive(),
  transcriptId: z.number().int().positive().optional(),
  userId: z.number().int().positive(),
  generationRunId: z.string().trim().min(1),
});

const renderClipCandidateJobPayloadSchema = z.object({
  clipCandidateId: z.number().int().positive(),
  contentPackId: z.number().int().positive(),
  sourceAssetId: z.number().int().positive(),
  userId: z.number().int().positive(),
  generationRunId: z.string().trim().min(1),
  captionsEnabled: z.boolean().optional(),
  captionFontAssetId: z.number().int().positive().optional(),
});

const formatRenderedClipShortFormJobPayloadSchema = z.object({
  clipCandidateId: z.number().int().positive(),
  contentPackId: z.number().int().positive(),
  sourceAssetId: z.number().int().positive(),
  userId: z.number().int().positive(),
  generationRunId: z.string().trim().min(1),
  renderConfigId: z.number().int().positive().optional(),
  variant: z.nativeEnum(RenderedClipVariant).optional(),
  layout: z.nativeEnum(RenderedClipLayout).optional(),
  captionsEnabled: z.boolean().optional(),
  captionFontAssetId: z.number().int().positive().optional(),
  editConfigHash: z.string().min(1).optional(),
});

const detectClipFacecamJobPayloadSchema = z.object({
  videoId: z.number().int().positive(),
  sourceAssetId: z.number().int().positive(),
  userId: z.number().int().positive(),
  contentPackId: z.number().int().positive().optional(),
  generationRunId: z.string().trim().min(1).optional(),
});

const publishRenderedClipJobPayloadSchema = z.object({
  clipPublicationId: z.number().int().positive(),
  renderedClipId: z.number().int().positive(),
  linkedAccountId: z.number().int().positive(),
  userId: z.number().int().positive(),
  platform: z.enum(['youtube', 'tiktok']),
});

export type ClaimedPipelineJob =
  | (Job & {
      type: JobType.TRANSCRIBE_SOURCE_ASSET;
      payload: TranscribeSourceAssetJobPayload;
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

function isStaleTranscriptionStartedAt(
  startedAt: Date | null | undefined,
  now: Date = new Date()
) {
  if (!startedAt) {
    return false;
  }

  return startedAt.getTime() <= now.getTime() - TRANSCRIPTION_STALE_MS;
}

async function failStaleProcessingTranscriptionJobs(
  executor: DbLike,
  sourceAssetId: number,
  now: Date = new Date()
) {
  const staleProcessingStartedBefore = new Date(
    now.getTime() - TRANSCRIPTION_STALE_MS
  );

  await executor
    .update(jobs)
    .set({
      status: JobStatus.FAILED,
      completedAt: new Date(),
      failureReason: TRANSCRIPTION_STALE_FAILURE_REASON,
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(jobs.type, [
          JobType.TRANSCRIBE_SOURCE_ASSET,
          JobType.INGEST_YOUTUBE_SOURCE_ASSET,
        ]),
        eq(jobs.status, JobStatus.PROCESSING),
        lt(jobs.startedAt, staleProcessingStartedBefore),
        sql<boolean>`payload->>'sourceAssetId' = ${String(sourceAssetId)}`
      )
    );
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

function isStaleShortFormStartedAt(
  startedAt: Date | null | undefined,
  now: Date = new Date()
) {
  if (!startedAt) {
    return false;
  }

  return startedAt.getTime() <= now.getTime() - SHORT_FORM_PACK_STALE_MS;
}

async function failStaleProcessingShortFormJobs(
  executor: DbLike,
  contentPackId: number,
  now: Date = new Date()
) {
  const staleProcessingStartedBefore = new Date(
    now.getTime() - SHORT_FORM_PACK_STALE_MS
  );

  await executor
    .update(jobs)
    .set({
      status: JobStatus.FAILED,
      completedAt: new Date(),
      failureReason: SHORT_FORM_PACK_STALE_FAILURE_REASON,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(jobs.type, JobType.GENERATE_SHORT_FORM_PACK),
        eq(jobs.status, JobStatus.PROCESSING),
        lt(jobs.startedAt, staleProcessingStartedBefore),
        sql<boolean>`payload->>'contentPackId' = ${String(contentPackId)}`
      )
    );
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
  variant: RenderedClipVariant,
  layout: RenderedClipLayout,
  editConfigHash?: string
) {
  return await executor.query.jobs.findFirst({
    where: and(
      eq(jobs.type, JobType.FORMAT_RENDERED_CLIP_SHORT_FORM),
      inArray(jobs.status, [JobStatus.PENDING, JobStatus.PROCESSING]),
      sql<boolean>`payload->>'clipCandidateId' = ${String(clipCandidateId)}`,
      sql<boolean>`coalesce(payload->>'variant', ${RenderedClipVariant.VERTICAL_SHORT_FORM}) = ${variant}`,
      sql<boolean>`coalesce(payload->>'layout', ${RenderedClipLayout.DEFAULT}) = ${layout}`,
      sql<boolean>`coalesce(payload->>'editConfigHash', '') = ${editConfigHash ?? ''}`
    ),
  });
}

async function findCurrentRenderedClipForConfig(
  executor: DbLike,
  clipCandidateId: number,
  variant: RenderedClipVariant,
  layout: RenderedClipLayout,
  editConfigHash?: string
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

async function failStaleProcessingFacecamDetectionJobs(
  executor: DbLike,
  clipCandidateId: number,
  now: Date = new Date()
) {
  const staleProcessingStartedBefore = new Date(
    now.getTime() - FACECAM_DETECTION_STALE_MS
  );

  await executor
    .update(jobs)
    .set({
      status: JobStatus.FAILED,
      completedAt: new Date(),
      failureReason: FACECAM_DETECTION_STALE_FAILURE_REASON,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(jobs.type, JobType.DETECT_CLIP_FACECAM),
        eq(jobs.status, JobStatus.PROCESSING),
        lt(jobs.startedAt, staleProcessingStartedBefore),
        sql<boolean>`payload->>'clipCandidateId' = ${String(clipCandidateId)}`
      )
    );
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

  const [job] = await executor
    .insert(jobs)
    .values({
      type: JobType.TRANSCRIBE_SOURCE_ASSET,
      status: JobStatus.PENDING,
      payload,
    })
    .returning();

  return job;
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
      if (
        existingJob.status !== JobStatus.PROCESSING ||
        !isStaleTranscriptionStartedAt(existingJob.startedAt, now)
      ) {
        continue;
      }

      await failStaleProcessingTranscriptionJobs(db, sourceAsset.id, now);
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
      if (
        activeJob.type === JobType.GENERATE_SHORT_FORM_PACK &&
        activeJob.status === JobStatus.PROCESSING &&
        isStaleShortFormStartedAt(activeJob.startedAt, now)
      ) {
        await db.transaction(async (tx) => {
          await failStaleProcessingShortFormJobs(tx, pack.id, now);
          await tx
            .update(contentPacks)
            .set({
              status: ContentPackStatus.FAILED,
              failureReason: SHORT_FORM_PACK_STALE_FAILURE_REASON,
              updatedAt: new Date(),
            })
            .where(eq(contentPacks.id, pack.id));
        });
        recoveredCount += 1;
      }

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
          shouldRetryEmptyUploadedShortFormPack({
            sourceAssetType: pack.sourceAsset.assetType,
            clipCandidateCount: pack.clipCandidates.length,
            hasCompletedGenerateJob: true,
            hasMissingCandidateCancellation,
          }) ||
          completedGenerateJobCount <= 1
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
          eq(sourceAssets.id, payload.data.videoId),
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

    if (
      job.status === JobStatus.PROCESSING &&
      isStaleFacecamDetectionStartedAt(job.startedAt, now)
    ) {
      await markJobFailed(job.id, FACECAM_DETECTION_STALE_FAILURE_REASON);
      recoveredCount += 1;
    }
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

  const [job] = await executor
    .insert(jobs)
    .values({
      type: JobType.INGEST_YOUTUBE_SOURCE_ASSET,
      status: JobStatus.PENDING,
      payload,
    })
    .returning();

  return job;
}

export async function enqueueShortFormPackJob(
  contentPackId: number,
  sourceAssetId: number,
  transcriptId: number | undefined,
  userId: number,
  executor: DbLike = db
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
    executor
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
  };

  const [job] = await executor
    .insert(jobs)
    .values({
      type: JobType.GENERATE_SHORT_FORM_PACK,
      status: JobStatus.PENDING,
      payload,
    })
    .returning();

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

  const [job] = await executor
    .insert(jobs)
    .values({
      type: JobType.RENDER_CLIP_CANDIDATE,
      status: JobStatus.PENDING,
      payload,
    })
    .returning();

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
  if (!skipFacecamRenderGate) {
    await assertClipCandidateCanQueueRender(executor, clipCandidateId);
  }

  const currentRenderedClip = await findCurrentRenderedClipForConfig(
    executor,
    clipCandidateId,
    variant,
    layout,
    editConfigHash
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
    variant,
    layout,
    editConfigHash
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
    variant,
    layout,
    captionsEnabled,
    captionFontAssetId,
    editConfigHash,
  };

  const [job] = await executor
    .insert(jobs)
    .values({
      type: JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
      status: JobStatus.PENDING,
      payload,
    })
    .returning();

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

export async function enqueueDetectVideoFacecamJob(
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

  const [job] = await executor
    .insert(jobs)
    .values({
      type: JobType.PUBLISH_RENDERED_CLIP,
      status: JobStatus.PENDING,
      payload,
    })
    .returning();

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

export async function claimNextJob() {
  return await db.transaction(async (tx) => {
    const maxRenderConcurrency = getMaxRenderConcurrency();
    const maxFacecamConcurrency = getMaxFacecamConcurrency();
    const rows = await tx.execute<{ id: number }>(sql`
      select "jobs"."id"
      from "jobs"
      where "jobs"."status" = ${JobStatus.PENDING}
        and "jobs"."available_at" <= now()
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
      return null;
    }

    const [job] = await tx
      .update(jobs)
      .set({
        status: JobStatus.PROCESSING,
        attemptCount: sql`${jobs.attemptCount} + 1`,
        startedAt: new Date(),
        failureReason: null,
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, nextJobId))
      .returning();

    if (!job) {
      return null;
    }

    const payload = parseJobPayload(job.type as JobType, job.payload as JobPayload);

    return {
      ...job,
      type: job.type as ClaimedPipelineJob['type'],
      payload,
    } as ClaimedPipelineJob;
  });
}

export async function markJobCompleted(jobId: number) {
  await db
    .update(jobs)
    .set({
      status: JobStatus.COMPLETED,
      completedAt: new Date(),
      failureReason: null,
      updatedAt: new Date(),
    })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, JobStatus.PROCESSING)));
}

export async function markJobCancelled(
  jobId: number,
  reason: string | StaleJobReason
) {
  await db
    .update(jobs)
    .set({
      status: JobStatus.CANCELLED,
      completedAt: new Date(),
      failureReason: buildCancelledReason(reason),
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, jobId));
}

export async function requeueJob(jobId: number, availableAt = new Date()) {
  await db
    .update(jobs)
    .set({
      status: JobStatus.PENDING,
      availableAt,
      startedAt: null,
      failureReason: null,
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, jobId));
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
  executor: DbLike = db
) {
  await executor
    .update(jobs)
    .set({
      status: JobStatus.CANCELLED,
      completedAt: new Date(),
      failureReason: buildCancelledReason(reason),
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
  transcriptId?: number
) {
  await db
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

export async function markJobFailed(jobId: number, reason: string) {
  await db
    .update(jobs)
    .set({
      status: JobStatus.FAILED,
      completedAt: new Date(),
      failureReason: normalizeFailureReason(reason),
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, jobId));
}
