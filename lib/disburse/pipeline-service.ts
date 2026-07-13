import 'server-only';

import {
  acknowledgeJobCancellation,
  claimNextJob,
  type ClaimedPipelineJob,
  enqueueShortFormPackJob,
  enqueueTranscriptionJob,
  enqueueYoutubeIngestionJob,
  heartbeatJobLease,
  isJobLeaseLostError,
  markJobCompleted,
  markJobFailed,
  requeueJob,
  wakeShortFormPackJobsForSourceAsset,
  withAuthorizedMissingCandidateCancellation,
  withAuthorizedJobCompletion,
  withAuthorizedJobCancellation,
  withAuthorizedJobFailure,
} from '@/lib/disburse/job-service';
import {
  getUserSafePipelineFailureReason,
  logPipelineError,
} from '@/lib/disburse/pipeline-errors';
import {
  detectCandidateFacecam,
  detectVideoFacecam,
  getFacecamFailureStatusForError,
  getFacecamFallbackQueueReason,
  markCandidateFacecamDetectionFailed,
  markVideoFacecamDetectionFailed,
} from '@/lib/disburse/facecam-detection-service';
import { MediaApiFacecamDetectionError } from '@/lib/disburse/media-api-client';
import {
  applyFacecamResultToClipEditConfig,
  getRenderedClipVariantForEditConfig,
} from '@/lib/disburse/clip-edit-config-service';
import { createRenderableRenderConfigsForEditConfig } from '@/lib/disburse/brand-template-service';
import { triggerInternalJobProcessing } from '@/lib/disburse/internal-job-trigger';
import {
  markClipPublicationFailed,
  markClipPublicationPublished,
  publishRenderedClipPublication,
} from '@/lib/disburse/publishing-service';
import {
  formatRenderedClipShortFormCandidate,
  markRenderedClipFailed,
  renderApprovedClipCandidate,
} from '@/lib/disburse/rendered-clip-service';
import {
  generateShortFormPack,
  markContentPackFailed,
  reconcileShortFormContentPackStatus,
} from '@/lib/disburse/short-form-service';
import { markTranscriptFailed } from '@/lib/disburse/transcript-service';
import { transcribeSourceAsset } from '@/lib/disburse/transcription-service';
import { extractSourceAssetThumbnail } from '@/lib/disburse/source-asset-thumbnail-service';
import { ingestYoutubeSourceAsset } from '@/lib/disburse/youtube-ingestion-service';
import { enqueueFormatRenderedClipShortFormJob } from '@/lib/disburse/job-service';
import {
  ContentPackStatus,
  JobType,
  JobStatus,
  RenderedClipLayout,
  RenderedClipVariant,
  SourceAssetType,
  TranscriptStatus,
  type ClipEditConfig,
  clipCandidates,
  contentPacks,
  jobs,
  sourceAssets,
} from '@/lib/db/schema';
import { db } from '@/lib/db/drizzle';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { isMediaUnavailable } from '@/lib/disburse/media-retention-service';
import {
  isStaleJobError,
  StaleJobReason,
  type StaleJobReason as StaleJobReasonValue,
} from '@/lib/disburse/stale-job';
import {
  assertJobExecutionAuthorized,
  JobExecutionUnauthorizedError,
  type JobAuthorizationExecutor,
  type JobExecutionAuthority,
  withAuthorizedJobTransaction,
} from '@/lib/disburse/job-execution-authorization';

const PIPELINE_TRANSCRIPT_WAIT_MS = 30 * 1000;
const JOB_LEASE_HEARTBEAT_INTERVAL_MS = 60 * 1000;

function getJobExecutionAuthority(
  job: ClaimedPipelineJob,
  signal?: AbortSignal
): JobExecutionAuthority {
  return { jobId: job.id, leaseToken: job.leaseToken!, signal };
}

type StaleValidationResult = {
  reason: StaleJobReasonValue;
  projectId: number | null;
  sourceAssetId: number | null;
  contentPackId: number | null;
  clipCandidateId: number | null;
  generationRunId: string | null;
};

function buildStaleValidationResult(
  reason: StaleJobReasonValue,
  context: Partial<Omit<StaleValidationResult, 'reason'>>
): StaleValidationResult {
  return {
    reason,
    projectId: context.projectId ?? null,
    sourceAssetId: context.sourceAssetId ?? null,
    contentPackId: context.contentPackId ?? null,
    clipCandidateId: context.clipCandidateId ?? null,
    generationRunId: context.generationRunId ?? null,
  };
}

function getSourceAssetStaleReason(sourceAsset: {
  deletedAt: Date | null;
  storageDeletedAt: Date | null;
  storageKey: string | null;
  assetType: string;
  retentionStatus: string | null;
}) {
  if (sourceAsset.deletedAt || isMediaUnavailable(sourceAsset)) {
    return StaleJobReason.SOURCE_ASSET_DELETED;
  }

  if (
    sourceAsset.assetType === SourceAssetType.UPLOADED_FILE &&
    !sourceAsset.storageKey
  ) {
    return StaleJobReason.STORAGE_OBJECT_MISSING;
  }

  return null;
}

async function enqueueFormatJobsForClipRenderConfigs(params: {
  editConfig: ClipEditConfig;
  queueReason: string;
}, executor: JobAuthorizationExecutor = db) {
  const renderConfigs = await createRenderableRenderConfigsForEditConfig(
    params.editConfig,
    executor
  );

  for (const renderConfig of renderConfigs) {
    await enqueueFormatRenderedClipShortFormJob(
      renderConfig.clipCandidateId,
      renderConfig.contentPackId,
      renderConfig.sourceAssetId,
      renderConfig.userId,
      renderConfig.generationRunId,
      getRenderedClipVariantForEditConfig(renderConfig),
      renderConfig.layout as RenderedClipLayout,
      renderConfig.captionsEnabled,
      renderConfig.captionFontAssetId ?? undefined,
      renderConfig.configHash,
      renderConfig.id,
      true,
      params.queueReason,
      executor
    );
  }

  return renderConfigs.length;
}

async function validateGenerateShortFormJob(
  job: Extract<ClaimedPipelineJob, { type: JobType.GENERATE_SHORT_FORM_PACK }>
): Promise<StaleValidationResult | null> {
  const contentPack = await db.query.contentPacks.findFirst({
    where: and(
      eq(contentPacks.id, job.payload.contentPackId),
      eq(contentPacks.userId, job.payload.userId)
    ),
    with: {
      project: true,
      sourceAsset: true,
    },
  });

  if (!contentPack) {
    return buildStaleValidationResult(StaleJobReason.CONTENT_PACK_MISSING, {
      sourceAssetId: job.payload.sourceAssetId,
      contentPackId: job.payload.contentPackId,
      generationRunId: job.payload.generationRunId,
    });
  }

  const sourceAssetStaleReason = getSourceAssetStaleReason(contentPack.sourceAsset);

  if (sourceAssetStaleReason) {
    return buildStaleValidationResult(sourceAssetStaleReason, {
      projectId: contentPack.projectId,
      sourceAssetId: contentPack.sourceAssetId,
      contentPackId: contentPack.id,
      generationRunId: job.payload.generationRunId,
    });
  }

  if (contentPack.generationRunId !== job.payload.generationRunId) {
    return buildStaleValidationResult(StaleJobReason.GENERATION_RUN_STALE, {
      projectId: contentPack.projectId,
      sourceAssetId: contentPack.sourceAssetId,
      contentPackId: contentPack.id,
      generationRunId: job.payload.generationRunId,
    });
  }

  return null;
}

async function validateClipPipelineJob(
  job: Extract<
    ClaimedPipelineJob,
    | { type: JobType.RENDER_CLIP_CANDIDATE }
    | { type: JobType.FORMAT_RENDERED_CLIP_SHORT_FORM }
  >
): Promise<StaleValidationResult | null> {
  const candidate = await db.query.clipCandidates.findFirst({
    where: and(
      eq(clipCandidates.id, job.payload.clipCandidateId),
      eq(clipCandidates.userId, job.payload.userId)
    ),
    with: {
      contentPack: {
        with: {
          project: true,
        },
      },
      sourceAsset: true,
      editConfig: true,
    },
  });

  if (!candidate) {
    return buildStaleValidationResult(StaleJobReason.CLIP_CANDIDATE_MISSING, {
      sourceAssetId: job.payload.sourceAssetId,
      contentPackId: job.payload.contentPackId,
      clipCandidateId: job.payload.clipCandidateId,
      generationRunId: job.payload.generationRunId,
    });
  }

  const sourceAssetStaleReason = getSourceAssetStaleReason(candidate.sourceAsset);

  if (sourceAssetStaleReason) {
    return buildStaleValidationResult(sourceAssetStaleReason, {
      projectId: candidate.contentPack.projectId,
      sourceAssetId: candidate.sourceAssetId,
      contentPackId: candidate.contentPackId,
      clipCandidateId: candidate.id,
      generationRunId: job.payload.generationRunId,
    });
  }

  if (
    candidate.contentPack.generationRunId !== job.payload.generationRunId ||
    candidate.generationRunId !== job.payload.generationRunId
  ) {
    return buildStaleValidationResult(StaleJobReason.GENERATION_RUN_STALE, {
      projectId: candidate.contentPack.projectId,
      sourceAssetId: candidate.sourceAssetId,
      contentPackId: candidate.contentPackId,
      clipCandidateId: candidate.id,
      generationRunId: job.payload.generationRunId,
    });
  }

  if (job.type === JobType.FORMAT_RENDERED_CLIP_SHORT_FORM) {
    if (!candidate.editConfig) {
      return buildStaleValidationResult(StaleJobReason.EDIT_CONFIG_MISSING, {
        projectId: candidate.contentPack.projectId,
        sourceAssetId: candidate.sourceAssetId,
        contentPackId: candidate.contentPackId,
        clipCandidateId: candidate.id,
        generationRunId: job.payload.generationRunId,
      });
    }

    if (candidate.editConfig.generationRunId !== job.payload.generationRunId) {
      return buildStaleValidationResult(StaleJobReason.EDIT_CONFIG_MISSING, {
        projectId: candidate.contentPack.projectId,
        sourceAssetId: candidate.sourceAssetId,
        contentPackId: candidate.contentPackId,
        clipCandidateId: candidate.id,
        generationRunId: job.payload.generationRunId,
      });
    }

    if (
      job.payload.editConfigHash &&
      candidate.editConfig.configHash !== job.payload.editConfigHash
    ) {
      return buildStaleValidationResult(StaleJobReason.ARTIFACT_REPLACED, {
        projectId: candidate.contentPack.projectId,
        sourceAssetId: candidate.sourceAssetId,
        contentPackId: candidate.contentPackId,
        clipCandidateId: candidate.id,
        generationRunId: job.payload.generationRunId,
      });
    }
  }

  return null;
}

async function validateVideoFacecamJob(
  job: Extract<ClaimedPipelineJob, { type: JobType.DETECT_CLIP_FACECAM }>
): Promise<StaleValidationResult | null> {
  if (job.payload.clipCandidateId && job.payload.generationRunId) {
    const candidate = await db.query.clipCandidates.findFirst({
      where: and(
        eq(clipCandidates.id, job.payload.clipCandidateId),
        eq(clipCandidates.userId, job.payload.userId)
      ),
      with: {
        contentPack: {
          with: {
            project: true,
          },
        },
        sourceAsset: true,
      },
    });

    if (!candidate) {
      return buildStaleValidationResult(StaleJobReason.CLIP_CANDIDATE_MISSING, {
        sourceAssetId: job.payload.sourceAssetId,
        contentPackId: job.payload.contentPackId ?? null,
        clipCandidateId: job.payload.clipCandidateId,
        generationRunId: job.payload.generationRunId,
      });
    }

    const sourceAssetStaleReason = getSourceAssetStaleReason(candidate.sourceAsset);

    if (sourceAssetStaleReason) {
      return buildStaleValidationResult(sourceAssetStaleReason, {
        projectId: candidate.contentPack.projectId,
        sourceAssetId: candidate.sourceAssetId,
        contentPackId: candidate.contentPackId,
        clipCandidateId: candidate.id,
        generationRunId: job.payload.generationRunId,
      });
    }

    if (
      candidate.contentPack.generationRunId !== job.payload.generationRunId ||
      candidate.generationRunId !== job.payload.generationRunId
    ) {
      return buildStaleValidationResult(StaleJobReason.GENERATION_RUN_STALE, {
        projectId: candidate.contentPack.projectId,
        sourceAssetId: candidate.sourceAssetId,
        contentPackId: candidate.contentPackId,
        clipCandidateId: candidate.id,
        generationRunId: job.payload.generationRunId,
      });
    }

    return null;
  }

  if (!job.payload.videoId) {
    return buildStaleValidationResult(StaleJobReason.SOURCE_ASSET_DELETED, {
      sourceAssetId: job.payload.sourceAssetId,
      contentPackId: job.payload.contentPackId ?? null,
    });
  }

  const sourceAsset = await db.query.sourceAssets.findFirst({
    where: and(
      eq(sourceAssets.id, job.payload.videoId),
      eq(sourceAssets.userId, job.payload.userId)
    ),
    with: {
      project: true,
    },
  });

  if (!sourceAsset) {
    return buildStaleValidationResult(StaleJobReason.SOURCE_ASSET_DELETED, {
      sourceAssetId: job.payload.sourceAssetId,
      contentPackId: job.payload.contentPackId ?? null,
    });
  }

  const sourceAssetStaleReason = getSourceAssetStaleReason(sourceAsset);

  if (sourceAssetStaleReason) {
    return buildStaleValidationResult(sourceAssetStaleReason, {
      projectId: sourceAsset.projectId,
      sourceAssetId: sourceAsset.id,
      contentPackId: job.payload.contentPackId ?? null,
    });
  }

  return null;
}

async function validateJobFreshness(
  job: ClaimedPipelineJob
): Promise<StaleValidationResult | null> {
  switch (job.type) {
    case JobType.GENERATE_SHORT_FORM_PACK:
      return await validateGenerateShortFormJob(job);
    case JobType.RENDER_CLIP_CANDIDATE:
    case JobType.FORMAT_RENDERED_CLIP_SHORT_FORM:
      return await validateClipPipelineJob(job);
    case JobType.DETECT_CLIP_FACECAM:
      return await validateVideoFacecamJob(job);
    default:
      return null;
  }
}

async function cancelStaleJob(
  job: ClaimedPipelineJob,
  stale: StaleValidationResult,
  authority: JobExecutionAuthority = getJobExecutionAuthority(job)
) {
  if (stale.reason === StaleJobReason.CLIP_CANDIDATE_MISSING) {
    await withAuthorizedMissingCandidateCancellation(authority, async (tx) => {
      await requeueCurrentGenerationWhenCandidatesDisappear(job, stale, tx);
    });
  } else {
    await withAuthorizedJobCancellation(
      authority,
      stale.reason,
      async () => undefined
    );
  }

  console.info('pipeline_job.cancelled_stale', {
    jobId: job.id,
    jobType: job.type,
    projectId: stale.projectId,
    sourceAssetId: stale.sourceAssetId,
    contentPackId: stale.contentPackId,
    candidateId: stale.clipCandidateId,
    generationRunId: stale.generationRunId,
    staleReason: stale.reason,
  });
}

function isCandidateScopedJob(job: ClaimedPipelineJob) {
  return (
    job.type === JobType.RENDER_CLIP_CANDIDATE ||
    job.type === JobType.FORMAT_RENDERED_CLIP_SHORT_FORM ||
    job.type === JobType.DETECT_CLIP_FACECAM
  ) && 'clipCandidateId' in job.payload;
}

async function requeueCurrentGenerationWhenCandidatesDisappear(
  job: ClaimedPipelineJob,
  stale: StaleValidationResult,
  executor: JobAuthorizationExecutor
) {
  if (
    !('contentPackId' in job.payload) ||
    !('sourceAssetId' in job.payload) ||
    !('userId' in job.payload) ||
    !('generationRunId' in job.payload) ||
    typeof job.payload.contentPackId !== 'number' ||
    typeof job.payload.generationRunId !== 'string'
  ) {
    return;
  }

  const contentPack = await executor.query.contentPacks.findFirst({
    where: and(
      eq(contentPacks.id, job.payload.contentPackId),
      eq(contentPacks.userId, job.payload.userId)
    ),
    columns: {
      id: true,
      sourceAssetId: true,
      transcriptId: true,
      generationRunId: true,
      status: true,
    },
    with: {
      clipCandidates: {
        columns: {
          id: true,
        },
      },
    },
  });

  if (!contentPack) {
    return;
  }

  if (
    contentPack.generationRunId !== job.payload.generationRunId ||
    contentPack.clipCandidates.length > 0
  ) {
    return;
  }

  const existingGenerationJob = await executor.query.jobs.findFirst({
    where: and(
      eq(jobs.type, JobType.GENERATE_SHORT_FORM_PACK),
      inArray(jobs.status, [JobStatus.PENDING, JobStatus.PROCESSING]),
      sql<boolean>`payload->>'contentPackId' = ${String(contentPack.id)}`
    ),
    columns: {
      id: true,
    },
  });

  if (existingGenerationJob) {
    return;
  }

  await enqueueShortFormPackJob(
    contentPack.id,
    contentPack.sourceAssetId,
    contentPack.transcriptId ?? undefined,
    job.payload.userId,
    undefined,
    executor,
    job.id
  );

  await executor
    .update(contentPacks)
    .set({
      status: ContentPackStatus.PENDING,
      failureReason: null,
      updatedAt: new Date(),
    })
    .where(eq(contentPacks.id, contentPack.id));

  console.info('pipeline_job.requeued_missing_candidates', {
    staleReason: stale.reason,
    contentPackId: contentPack.id,
    sourceAssetId: contentPack.sourceAssetId,
    previousGenerationRunId: job.payload.generationRunId,
    missingClipCandidateId:
      'clipCandidateId' in job.payload ? job.payload.clipCandidateId : null,
  });
}

async function waitForTranscriptAndRequeueGeneration(job: Extract<
  ClaimedPipelineJob,
  { type: JobType.GENERATE_SHORT_FORM_PACK }
>, authority: JobExecutionAuthority) {
  const sourceAsset = await db.query.sourceAssets.findFirst({
    where: and(
      eq(sourceAssets.id, job.payload.sourceAssetId),
      eq(sourceAssets.userId, job.payload.userId)
    ),
    with: {
      transcript: {
        with: {
          segments: true,
        },
      },
    },
  });

  if (!sourceAsset) {
    throw new Error('Source asset not found.');
  }

  if (sourceAsset.transcript?.status === TranscriptStatus.READY) {
    await withAuthorizedJobTransaction(authority, async (tx) => {
      await tx
        .update(contentPacks)
        .set({
          transcriptId: sourceAsset.transcript!.id,
          updatedAt: new Date(),
        })
        .where(eq(contentPacks.id, job.payload.contentPackId));
    });
    return sourceAsset.transcript;
  }

  if (
    sourceAsset.transcript?.status === TranscriptStatus.FAILED &&
    job.attemptCount > 1
  ) {
    throw new Error(
      sourceAsset.transcript.failureReason || 'Transcript processing failed.'
    );
  }

  await withAuthorizedJobTransaction(authority, async (tx) => {
    if (sourceAsset.assetType === SourceAssetType.UPLOADED_FILE) {
      await enqueueTranscriptionJob(sourceAsset.id, job.payload.userId, tx);
    } else if (sourceAsset.assetType === SourceAssetType.YOUTUBE_URL) {
      await enqueueYoutubeIngestionJob(sourceAsset.id, job.payload.userId, tx);
    } else {
      throw new Error('This source asset type does not support clip generation.');
    }

    await tx
      .update(contentPacks)
      .set({
        status: ContentPackStatus.GENERATING,
        failureReason: null,
        updatedAt: new Date(),
      })
      .where(eq(contentPacks.id, job.payload.contentPackId));
    await requeueJob(
      job.id,
      job.leaseToken!,
      new Date(Date.now() + PIPELINE_TRANSCRIPT_WAIT_MS),
      tx
    );
  });
  triggerInternalJobProcessing();

  return null;
}

export type PipelineProcessingRuntime = {
  lease: {
    heartbeat: typeof heartbeatJobLease;
  };
  authorization: {
    assert: typeof assertJobExecutionAuthorized;
    validateFreshness: typeof validateJobFreshness;
  };
  processors: {
    transcribe: typeof transcribeSourceAsset;
    extractThumbnail: typeof extractSourceAssetThumbnail;
    ingestYoutube: typeof ingestYoutubeSourceAsset;
    waitForTranscript: typeof waitForTranscriptAndRequeueGeneration;
    generateShortForm: typeof generateShortFormPack;
    renderClip: typeof renderApprovedClipCandidate;
    formatClip: typeof formatRenderedClipShortFormCandidate;
    detectCandidateFacecam: typeof detectCandidateFacecam;
    detectVideoFacecam: typeof detectVideoFacecam;
    publishClip: typeof publishRenderedClipPublication;
  };
  downstream: {
    trigger: typeof triggerInternalJobProcessing;
  };
  timer: {
    startHeartbeat(callback: () => void, intervalMs: number): unknown;
    stopHeartbeat(handle: unknown): void;
  };
};

export const productionPipelineProcessingRuntime: PipelineProcessingRuntime = {
  lease: { heartbeat: heartbeatJobLease },
  authorization: {
    assert: assertJobExecutionAuthorized,
    validateFreshness: validateJobFreshness,
  },
  processors: {
    transcribe: transcribeSourceAsset,
    extractThumbnail: extractSourceAssetThumbnail,
    ingestYoutube: ingestYoutubeSourceAsset,
    waitForTranscript: waitForTranscriptAndRequeueGeneration,
    generateShortForm: generateShortFormPack,
    renderClip: renderApprovedClipCandidate,
    formatClip: formatRenderedClipShortFormCandidate,
    detectCandidateFacecam,
    detectVideoFacecam,
    publishClip: publishRenderedClipPublication,
  },
  downstream: { trigger: triggerInternalJobProcessing },
  timer: {
    startHeartbeat: (callback, intervalMs) => setInterval(callback, intervalMs),
    stopHeartbeat: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  },
};

export async function processClaimedJob(
  job: ClaimedPipelineJob,
  runtime: PipelineProcessingRuntime = productionPipelineProcessingRuntime
) {

  const authorityController = new AbortController();
  const authority = getJobExecutionAuthority(job, authorityController.signal);
  let heartbeatLostAuthority = false;
  let heartbeatAuthorityLossReason:
    | 'heartbeat_renewal_rejected'
    | 'heartbeat_renewal_failed'
    | null = null;

  const assertAuthority = async () => {
    if (heartbeatLostAuthority) {
      throw new JobExecutionUnauthorizedError('lease_mismatch');
    }
    await runtime.authorization.assert(authority);
  };

  const heartbeat = runtime.timer.startHeartbeat(() => {
    void runtime.lease.heartbeat(job.id, job.leaseToken!)
      .then((renewed) => {
        if (!renewed) {
          heartbeatLostAuthority = true;
          authorityController.abort();
          heartbeatAuthorityLossReason = 'heartbeat_renewal_rejected';
          console.warn('pipeline_job.heartbeat_lease_lost', {
            jobId: job.id,
            jobType: job.type,
          });
        }
      })
      .catch((error) => {
        heartbeatLostAuthority = true;
        authorityController.abort();
        heartbeatAuthorityLossReason = 'heartbeat_renewal_failed';
        logPipelineError(job.type, error, {
          jobId: job.id,
          failureReason: 'Job lease heartbeat failed.',
        });
      });
  }, JOB_LEASE_HEARTBEAT_INTERVAL_MS);

  try {
    let staleValidation: StaleValidationResult | null;
    try {
      await assertAuthority();
      staleValidation = await runtime.authorization.validateFreshness(job);
    } catch (authorizationError) {
      if (
        !(authorizationError instanceof JobExecutionUnauthorizedError) ||
        authorizationError.reason !== 'related_record_missing' ||
        !isCandidateScopedJob(job)
      ) {
        throw authorizationError;
      }

      try {
        staleValidation = await runtime.authorization.validateFreshness(job);
      } catch {
        throw authorizationError;
      }
      if (staleValidation?.reason !== StaleJobReason.CLIP_CANDIDATE_MISSING) {
        throw authorizationError;
      }
    }

    if (staleValidation) {
      await cancelStaleJob(job, staleValidation, authority);
      runtime.downstream.trigger();

      return {
        processed: true,
        jobId: job.id,
        jobType: job.type,
        status: 'cancelled' as const,
        staleReason: staleValidation.reason,
      };
    }

    switch (job.type) {
      case JobType.TRANSCRIBE_SOURCE_ASSET: {
        const transcript = await runtime.processors.transcribe(
          job.payload.sourceAssetId,
          authority
        );
        await assertAuthority();
        await withAuthorizedJobCompletion(authority, async (tx) => {
          await wakeShortFormPackJobsForSourceAsset(
            job.payload.sourceAssetId,
            transcript.id,
            tx
          );
        });
        runtime.downstream.trigger();

        return {
          processed: true,
          jobId: job.id,
          jobType: job.type,
          sourceAssetId: job.payload.sourceAssetId,
          transcriptId: transcript.id,
          status: 'completed' as const,
        };
      }
      case JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL: {
        await runtime.processors.extractThumbnail(
          job.payload.sourceAssetId,
          job.payload.userId,
          authority
        );
        await assertAuthority();
        await markJobCompleted(job.id, job.leaseToken!);
        runtime.downstream.trigger();

        return {
          processed: true,
          jobId: job.id,
          jobType: job.type,
          sourceAssetId: job.payload.sourceAssetId,
          status: 'completed' as const,
        };
      }
      case JobType.INGEST_YOUTUBE_SOURCE_ASSET: {
        const transcript = await runtime.processors.ingestYoutube(
          job.payload.sourceAssetId,
          authority
        );
        await assertAuthority();
        await withAuthorizedJobCompletion(authority, async (tx) => {
          await wakeShortFormPackJobsForSourceAsset(
            job.payload.sourceAssetId,
            transcript.id,
            tx
          );
        });
        runtime.downstream.trigger();

        return {
          processed: true,
          jobId: job.id,
          jobType: job.type,
          sourceAssetId: job.payload.sourceAssetId,
          transcriptId: transcript.id,
          status: 'completed' as const,
        };
      }
      case JobType.GENERATE_SHORT_FORM_PACK: {
        const transcript = await runtime.processors.waitForTranscript(job, authority);

        if (!transcript) {
          return {
            processed: true,
            jobId: job.id,
            jobType: job.type,
            sourceAssetId: job.payload.sourceAssetId,
            contentPackId: job.payload.contentPackId,
            status: 'waiting_for_transcript' as const,
          };
        }

        const contentPack = await runtime.processors.generateShortForm(
          job.payload.contentPackId,
          job.payload.generationRunId,
          authority
        );
        await assertAuthority();
        await withAuthorizedJobCompletion(authority, async (tx) => {
          await reconcileShortFormContentPackStatus({
            contentPackId: contentPack.id,
            sourceAssetId: contentPack.sourceAssetId,
            generationRunId: contentPack.generationRunId,
          }, tx);
        });
        runtime.downstream.trigger();

        return {
          processed: true,
          jobId: job.id,
          jobType: job.type,
          sourceAssetId: job.payload.sourceAssetId,
          contentPackId: contentPack.id,
          status: 'completed' as const,
        };
      }
      case JobType.RENDER_CLIP_CANDIDATE: {
        const renderedClip = await runtime.processors.renderClip(
          job.payload.clipCandidateId,
          job.payload.captionsEnabled ?? true,
          job.payload.captionFontAssetId,
          { jobId: job.id, authority }
        );
        await assertAuthority();
        await markJobCompleted(job.id, job.leaseToken!);
        runtime.downstream.trigger();

        return {
          processed: true,
          jobId: job.id,
          jobType: job.type,
          sourceAssetId: job.payload.sourceAssetId,
          clipCandidateId: job.payload.clipCandidateId,
          renderedClipId: renderedClip.id,
          status: 'completed' as const,
        };
      }
      case JobType.FORMAT_RENDERED_CLIP_SHORT_FORM: {
        const renderedClip = await runtime.processors.formatClip(
          job.payload.clipCandidateId,
          job.payload.variant ?? RenderedClipVariant.VERTICAL_SHORT_FORM,
          job.payload.layout ?? RenderedClipLayout.DEFAULT,
          job.payload.captionsEnabled ?? true,
          job.payload.captionFontAssetId,
          job.payload.editConfigHash,
          job.payload.renderConfigId,
          { jobId: job.id, authority }
        );
        await assertAuthority();
        await withAuthorizedJobCompletion(authority, async (tx) => {
          await reconcileShortFormContentPackStatus({
            contentPackId: job.payload.contentPackId,
            sourceAssetId: job.payload.sourceAssetId,
            generationRunId: job.payload.generationRunId,
          }, tx);
        });
        runtime.downstream.trigger();

        return {
          processed: true,
          jobId: job.id,
          jobType: job.type,
          sourceAssetId: job.payload.sourceAssetId,
          clipCandidateId: job.payload.clipCandidateId,
          renderedClipId: renderedClip.id,
          status: 'completed' as const,
        };
      }
      case JobType.DETECT_CLIP_FACECAM: {
        if (
          job.payload.clipCandidateId &&
          job.payload.contentPackId &&
          job.payload.generationRunId &&
          typeof job.payload.startTimeMs === 'number' &&
          typeof job.payload.endTimeMs === 'number' &&
          job.payload.detectorVersion &&
          job.payload.detectionRunId
        ) {
          const result = await runtime.processors.detectCandidateFacecam({
            detectionRunId: job.payload.detectionRunId,
            clipCandidateId: job.payload.clipCandidateId,
            contentPackId: job.payload.contentPackId,
            sourceAssetId: job.payload.sourceAssetId,
            userId: job.payload.userId,
            generationRunId: job.payload.generationRunId,
            startTimeMs: job.payload.startTimeMs,
            endTimeMs: job.payload.endTimeMs,
            detectorVersion: job.payload.detectorVersion,
            jobId: job.id,
            authority,
          });
          await assertAuthority();
          await withAuthorizedJobCompletion(authority, async (tx) => {
            const editConfig = await applyFacecamResultToClipEditConfig({
              clipCandidateId: job.payload.clipCandidateId!,
              userId: job.payload.userId,
              generationRunId: job.payload.generationRunId!,
              status: result.status,
            }, tx);

            const queuedRenderConfigCount =
              await enqueueFormatJobsForClipRenderConfigs({
                editConfig,
                queueReason: getFacecamFallbackQueueReason(result.status),
              }, tx);

            if (queuedRenderConfigCount === 0) {
              await enqueueFormatRenderedClipShortFormJob(
                job.payload.clipCandidateId!,
                job.payload.contentPackId!,
                job.payload.sourceAssetId,
                job.payload.userId,
                job.payload.generationRunId!,
                getRenderedClipVariantForEditConfig(editConfig),
                editConfig.layout as RenderedClipLayout,
                editConfig.captionsEnabled,
                editConfig.captionFontAssetId ?? undefined,
                editConfig.configHash,
                undefined,
                true,
                getFacecamFallbackQueueReason(result.status),
                tx
              );
            }
            await reconcileShortFormContentPackStatus({
              contentPackId: job.payload.contentPackId!,
              sourceAssetId: job.payload.sourceAssetId,
              generationRunId: job.payload.generationRunId!,
            }, tx);
          });
          runtime.downstream.trigger();

          return {
            processed: true,
            jobId: job.id,
            jobType: job.type,
            sourceAssetId: job.payload.sourceAssetId,
            clipCandidateId: job.payload.clipCandidateId,
            detectionRunId: job.payload.detectionRunId,
            status: 'completed' as const,
            facecamDetectionStatus: result.status,
            detectionCount: result.detectionCount,
          };
        }

        if (!job.payload.videoId) {
          throw new Error('Legacy facecam detection job is missing a video id.');
        }

        const result = await runtime.processors.detectVideoFacecam(
          job.payload.videoId,
          job.payload.userId,
          { jobId: job.id, authority }
        );
        const candidates = job.payload.contentPackId
          ? await db.query.clipCandidates.findMany({
              where: and(
                eq(clipCandidates.contentPackId, job.payload.contentPackId),
                eq(clipCandidates.sourceAssetId, job.payload.videoId),
                eq(clipCandidates.userId, job.payload.userId)
              ),
            })
          : [];

        if (job.payload.contentPackId && candidates.length === 0) {
          console.warn('facecam_detection.candidates_missing', {
            jobId: job.id,
            sourceAssetId: job.payload.sourceAssetId,
            videoId: job.payload.videoId,
            contentPackId: job.payload.contentPackId,
            userId: job.payload.userId,
            facecamDetectionStatus: result.status,
            queueReason: 'facecam_completed_without_candidates',
          });

          await assertAuthority();
          await withAuthorizedJobCompletion(authority, async (tx) => {
            await enqueueShortFormPackJob(
              job.payload.contentPackId!,
              job.payload.sourceAssetId,
              undefined,
              job.payload.userId,
              undefined,
              tx
            );
          });
          runtime.downstream.trigger();

          return {
            processed: true,
            jobId: job.id,
            jobType: job.type,
            sourceAssetId: job.payload.sourceAssetId,
            videoId: job.payload.videoId,
            status: 'completed' as const,
            facecamDetectionStatus: result.status,
            detectionCount: result.detectionCount,
            recovered: 'requeued_short_form_pack' as const,
          };
        }

        for (const candidate of candidates) {
          await assertAuthority();
          await withAuthorizedJobTransaction(authority, async (tx) => {
            const editConfig = await applyFacecamResultToClipEditConfig({
              clipCandidateId: candidate.id,
              userId: job.payload.userId,
              generationRunId: candidate.generationRunId,
              status: result.status,
            }, tx);
            const queuedRenderConfigCount =
              await enqueueFormatJobsForClipRenderConfigs({
                editConfig,
                queueReason: getFacecamFallbackQueueReason(result.status),
              }, tx);

            if (queuedRenderConfigCount === 0) {
              await enqueueFormatRenderedClipShortFormJob(
                candidate.id,
                candidate.contentPackId,
                candidate.sourceAssetId,
                candidate.userId,
                candidate.generationRunId,
                getRenderedClipVariantForEditConfig(editConfig),
                editConfig.layout as RenderedClipLayout,
                editConfig.captionsEnabled,
                editConfig.captionFontAssetId ?? undefined,
                editConfig.configHash,
                undefined,
                true,
                getFacecamFallbackQueueReason(result.status),
                tx
              );
            }
          });
        }

        await assertAuthority();
        await withAuthorizedJobCompletion(authority, async (tx) => {
          if (job.payload.contentPackId && job.payload.generationRunId) {
            await reconcileShortFormContentPackStatus({
              contentPackId: job.payload.contentPackId,
              sourceAssetId: job.payload.sourceAssetId,
              generationRunId: job.payload.generationRunId,
            }, tx);
          }
        });
        runtime.downstream.trigger();

        return {
          processed: true,
          jobId: job.id,
          jobType: job.type,
          sourceAssetId: job.payload.sourceAssetId,
          videoId: job.payload.videoId,
          status: 'completed' as const,
          facecamDetectionStatus: result.status,
          detectionCount: result.detectionCount,
        };
      }
      case JobType.PUBLISH_RENDERED_CLIP: {
        const preparedPublication = await runtime.processors.publishClip(
          job.payload.clipPublicationId,
          authority
        );
        await assertAuthority();
        const publication = await withAuthorizedJobCompletion(
          authority,
          async (tx) => await markClipPublicationPublished({
            clipPublicationId: preparedPublication.publication.id,
            platformPostId: preparedPublication.result.platformPostId,
            platformUrl: preparedPublication.result.platformUrl,
          }, tx)
        );
        runtime.downstream.trigger();

        return {
          processed: true,
          jobId: job.id,
          jobType: job.type,
          renderedClipId: job.payload.renderedClipId,
          clipPublicationId: publication.id,
          status: 'completed' as const,
        };
      }
    }
  } catch (error) {
    if (error instanceof JobExecutionUnauthorizedError || heartbeatLostAuthority) {
      await acknowledgeJobCancellation(job.id, job.leaseToken!).catch(() => false);
      console.info('pipeline_job.authority_lost', {
        jobId: job.id,
        jobType: job.type,
        reason: heartbeatAuthorityLossReason ?? (
          error instanceof JobExecutionUnauthorizedError
            ? error.reason
            : 'heartbeat_authority_lost'
        ),
      });
      return {
        processed: true,
        jobId: job.id,
        jobType: job.type,
        status: 'lease_lost' as const,
      };
    }
    if (isJobLeaseLostError(error)) {
      return {
        processed: true,
        jobId: job.id,
        jobType: job.type,
        status: 'lease_lost' as const,
      };
    }
    if (isStaleJobError(error)) {
      const staleContext =
        'clipCandidateId' in job.payload
          ? {
              sourceAssetId: job.payload.sourceAssetId,
              contentPackId: job.payload.contentPackId,
              clipCandidateId: job.payload.clipCandidateId,
              generationRunId:
                'generationRunId' in job.payload
                  ? job.payload.generationRunId
                  : null,
            }
          : 'contentPackId' in job.payload
            ? {
                sourceAssetId: job.payload.sourceAssetId,
                contentPackId: job.payload.contentPackId,
                generationRunId:
                  'generationRunId' in job.payload
                    ? job.payload.generationRunId
                    : null,
              }
            : {};
      const staleValidation = buildStaleValidationResult(
        error.staleReason,
        staleContext
      );

      try {
        await assertAuthority();
        await cancelStaleJob(job, staleValidation, authority);
      } catch (cancellationError) {
        if (
          cancellationError instanceof JobExecutionUnauthorizedError ||
          isJobLeaseLostError(cancellationError)
        ) {
          return {
            processed: true,
            jobId: job.id,
            jobType: job.type,
            status: 'lease_lost' as const,
          };
        }
        throw cancellationError;
      }
      runtime.downstream.trigger();

      return {
        processed: true,
        jobId: job.id,
        jobType: job.type,
        status: 'cancelled' as const,
        staleReason: error.staleReason,
      };
    }

    const debugFailureReason =
      error instanceof Error
        ? error.message.trim() || 'Unknown pipeline error.'
        : 'Unknown pipeline error.';
    const failureReason = getUserSafePipelineFailureReason(job.type, error);

    try {
      await assertAuthority();
    } catch (authorizationError) {
      if (authorizationError instanceof JobExecutionUnauthorizedError) {
        console.info('pipeline_job.failure_suppressed_unauthorized', {
          jobId: job.id,
          jobType: job.type,
          reason: authorizationError.reason,
        });
        return {
          processed: true,
          jobId: job.id,
          jobType: job.type,
          status: 'lease_lost' as const,
        };
      }
      throw authorizationError;
    }

    logPipelineError(job.type, error, {
      jobId: job.id,
      sourceAssetId:
        'sourceAssetId' in job.payload ? job.payload.sourceAssetId : null,
      renderedClipId:
        'renderedClipId' in job.payload ? job.payload.renderedClipId : null,
      failureReason,
    });

    let failed = false;

    try {
      let jobFailureFinalized = false;

      if (job.type === JobType.GENERATE_SHORT_FORM_PACK) {
        await withAuthorizedJobFailure(
          authority,
          failureReason,
          async (tx) => {
            await markContentPackFailed(job.payload.contentPackId, failureReason, tx);
          }
        );
        jobFailureFinalized = true;
      } else if (job.type === JobType.RENDER_CLIP_CANDIDATE) {
        await withAuthorizedJobFailure(
          authority,
          failureReason,
          async (tx) => {
            await markRenderedClipFailed(
              job.payload.clipCandidateId,
              job.payload.userId,
              RenderedClipVariant.TRIMMED_ORIGINAL,
              failureReason,
              RenderedClipLayout.DEFAULT,
              tx
            );
          }
        );
        jobFailureFinalized = true;
      } else if (job.type === JobType.FORMAT_RENDERED_CLIP_SHORT_FORM) {
        await withAuthorizedJobFailure(
          authority,
          failureReason,
          async (tx) => {
            await markRenderedClipFailed(
              job.payload.clipCandidateId,
              job.payload.userId,
              job.payload.variant ?? RenderedClipVariant.VERTICAL_SHORT_FORM,
              failureReason,
              job.payload.layout ?? RenderedClipLayout.DEFAULT,
              tx
            );
          }
        );
        jobFailureFinalized = true;
      } else if (job.type === JobType.DETECT_CLIP_FACECAM) {
      const facecamFailureStatus = getFacecamFailureStatusForError(error);
      const facecamFailureContext =
        error instanceof MediaApiFacecamDetectionError
          ? {
              jobId: job.id,
              sourceAssetId: job.payload.sourceAssetId,
              timeoutMs: error.timeoutMs,
              requestDurationMs: error.durationMs,
              expectedAbort: error.expectedAbort,
              errorKind: error.kind,
            }
          : {
              jobId: job.id,
              sourceAssetId: job.payload.sourceAssetId,
            };

      if (job.payload.clipCandidateId && job.payload.generationRunId) {
        await withAuthorizedJobTransaction(authority, async (tx) => {
          await markCandidateFacecamDetectionFailed({
            detectionRunId: job.payload.detectionRunId,
            clipCandidateId: job.payload.clipCandidateId!,
            userId: job.payload.userId,
            reason: failureReason,
            debugReason: debugFailureReason,
            status: facecamFailureStatus,
            context: {
              ...facecamFailureContext,
              contentPackId: job.payload.contentPackId,
            },
          }, tx);
        });

        if (job.payload.contentPackId) {
          try {
            await withAuthorizedJobTransaction(authority, async (tx) => {
              const editConfig = await applyFacecamResultToClipEditConfig({
                clipCandidateId: job.payload.clipCandidateId!,
                userId: job.payload.userId,
                generationRunId: job.payload.generationRunId!,
                status: facecamFailureStatus,
                failureReason,
                debugReason: debugFailureReason,
              }, tx);
              const queuedRenderConfigCount =
                await enqueueFormatJobsForClipRenderConfigs({
                  editConfig,
                  queueReason: getFacecamFallbackQueueReason(facecamFailureStatus),
                }, tx);

              if (queuedRenderConfigCount === 0) {
                await enqueueFormatRenderedClipShortFormJob(
                  job.payload.clipCandidateId!,
                  job.payload.contentPackId!,
                  job.payload.sourceAssetId,
                  job.payload.userId,
                  job.payload.generationRunId!,
                  getRenderedClipVariantForEditConfig(editConfig),
                  editConfig.layout as RenderedClipLayout,
                  editConfig.captionsEnabled,
                  editConfig.captionFontAssetId ?? undefined,
                  editConfig.configHash,
                  undefined,
                  true,
                  getFacecamFallbackQueueReason(facecamFailureStatus),
                  tx
                );
              }
              await reconcileShortFormContentPackStatus({
                contentPackId: job.payload.contentPackId!,
                sourceAssetId: job.payload.sourceAssetId,
                generationRunId: job.payload.generationRunId!,
              }, tx);
            });
            runtime.downstream.trigger();
          } catch (fallbackError) {
            logPipelineError(job.type, fallbackError, {
              jobId: job.id,
              sourceAssetId: job.payload.sourceAssetId,
              failureReason: 'Candidate facecam fallback render could not be queued.',
            });
          }
        }
      } else if (job.payload.videoId) {
      await markVideoFacecamDetectionFailed(
        job.payload.videoId,
        job.payload.userId,
        failureReason,
        debugFailureReason,
        facecamFailureStatus,
        facecamFailureContext
      );
      try {
        const candidates = job.payload.contentPackId
          ? await db.query.clipCandidates.findMany({
              where: and(
                eq(clipCandidates.contentPackId, job.payload.contentPackId),
                eq(clipCandidates.sourceAssetId, job.payload.videoId),
                eq(clipCandidates.userId, job.payload.userId)
              ),
            })
          : [];

        if (job.payload.contentPackId && candidates.length === 0) {
          console.warn('facecam_detection.fallback_candidates_missing', {
            jobId: job.id,
            sourceAssetId: job.payload.sourceAssetId,
            videoId: job.payload.videoId,
            contentPackId: job.payload.contentPackId,
            userId: job.payload.userId,
            facecamDetectionStatus: facecamFailureStatus,
            queueReason: 'facecam_fallback_without_candidates',
          });

          await withAuthorizedJobTransaction(authority, async (tx) => {
            await enqueueShortFormPackJob(
              job.payload.contentPackId!,
              job.payload.sourceAssetId,
              undefined,
              job.payload.userId,
              undefined,
              tx
            );
          });
          runtime.downstream.trigger();
        }

        for (const candidate of candidates) {
          await withAuthorizedJobTransaction(authority, async (tx) => {
            const editConfig = await applyFacecamResultToClipEditConfig({
              clipCandidateId: candidate.id,
              userId: job.payload.userId,
              generationRunId: candidate.generationRunId,
              status: facecamFailureStatus,
              failureReason,
              debugReason: debugFailureReason,
            }, tx);
            const queuedRenderConfigCount =
              await enqueueFormatJobsForClipRenderConfigs({
                editConfig,
                queueReason: getFacecamFallbackQueueReason(facecamFailureStatus),
              }, tx);

            if (queuedRenderConfigCount === 0) {
              await enqueueFormatRenderedClipShortFormJob(
                candidate.id,
                candidate.contentPackId,
                candidate.sourceAssetId,
                candidate.userId,
                candidate.generationRunId,
                getRenderedClipVariantForEditConfig(editConfig),
                editConfig.layout as RenderedClipLayout,
                editConfig.captionsEnabled,
                editConfig.captionFontAssetId ?? undefined,
                editConfig.configHash,
                undefined,
                true,
                getFacecamFallbackQueueReason(facecamFailureStatus),
                tx
              );
            }
          });
        }

        if (job.payload.contentPackId && job.payload.generationRunId) {
          await withAuthorizedJobTransaction(authority, async (tx) => {
            await reconcileShortFormContentPackStatus({
              contentPackId: job.payload.contentPackId!,
              sourceAssetId: job.payload.sourceAssetId,
              generationRunId: job.payload.generationRunId!,
            }, tx);
          });
        }
        runtime.downstream.trigger();
      } catch (fallbackError) {
        logPipelineError(job.type, fallbackError, {
          jobId: job.id,
          sourceAssetId: job.payload.sourceAssetId,
          failureReason: 'Facecam fallback render could not be queued.',
        });
      }
      }
      } else if (job.type === JobType.PUBLISH_RENDERED_CLIP) {
      await withAuthorizedJobFailure(
        authority,
        failureReason,
        async (tx) => {
          await markClipPublicationFailed(
            job.payload.clipPublicationId,
            failureReason,
            tx
          );
        }
      );
      jobFailureFinalized = true;
      } else {
      await withAuthorizedJobFailure(
        authority,
        failureReason,
        async (tx) => {
          await markTranscriptFailed(
            job.payload.sourceAssetId,
            job.payload.userId,
            failureReason,
            tx
          );
          await wakeShortFormPackJobsForSourceAsset(
            job.payload.sourceAssetId,
            undefined,
            tx
          );
        }
      );
      jobFailureFinalized = true;
      }

      failed = jobFailureFinalized
        ? true
        : await markJobFailed(job.id, failureReason, job.leaseToken!);
    } catch (failureMutationError) {
      if (
        failureMutationError instanceof JobExecutionUnauthorizedError ||
        isJobLeaseLostError(failureMutationError)
      ) {
        return {
          processed: true,
          jobId: job.id,
          jobType: job.type,
          status: 'lease_lost' as const,
        };
      }
      throw failureMutationError;
    }
    if (!failed) {
      return {
        processed: true,
        jobId: job.id,
        jobType: job.type,
        status: 'lease_lost' as const,
      };
    }
    runtime.downstream.trigger();

    return {
      processed: true,
      jobId: job.id,
      jobType: job.type,
      sourceAssetId:
        'sourceAssetId' in job.payload ? job.payload.sourceAssetId : null,
      renderedClipId:
        'renderedClipId' in job.payload ? job.payload.renderedClipId : null,
      status: 'failed' as const,
      failureReason,
    };
  } finally {
    runtime.timer.stopHeartbeat(heartbeat);
  }
}

export async function processNextJob() {
  const job = await claimNextJob();

  if (!job) {
    return { processed: false };
  }

  return processClaimedJob(job);
}
