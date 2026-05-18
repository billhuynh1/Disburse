import 'server-only';

import {
  claimNextJob,
  type ClaimedPipelineJob,
  enqueueShortFormPackJob,
  enqueueTranscriptionJob,
  enqueueYoutubeIngestionJob,
  markJobCancelled,
  markJobCompleted,
  markJobFailed,
  requeueJob,
  wakeShortFormPackJobsForSourceAsset,
} from '@/lib/disburse/job-service';
import {
  getUserSafePipelineFailureReason,
  logPipelineError,
} from '@/lib/disburse/pipeline-errors';
import {
  detectVideoFacecam,
  getFacecamFailureStatusForError,
  getFacecamFallbackQueueReason,
  markVideoFacecamDetectionFailed,
} from '@/lib/disburse/facecam-detection-service';
import { MediaApiFacecamDetectionError } from '@/lib/disburse/media-api-client';
import {
  applyFacecamResultToClipEditConfig,
  getRenderedClipVariantForEditConfig,
} from '@/lib/disburse/clip-edit-config-service';
import { triggerInternalJobProcessing } from '@/lib/disburse/internal-job-trigger';
import {
  markClipPublicationFailed,
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

const PIPELINE_TRANSCRIPT_WAIT_MS = 30 * 1000;

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
  stale: StaleValidationResult
) {
  if (stale.reason === StaleJobReason.CLIP_CANDIDATE_MISSING) {
    await requeueCurrentGenerationWhenCandidatesDisappear(job, stale);
  }

  await markJobCancelled(job.id, stale.reason);

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

async function requeueCurrentGenerationWhenCandidatesDisappear(
  job: ClaimedPipelineJob,
  stale: StaleValidationResult
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

  const contentPack = await db.query.contentPacks.findFirst({
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

  const existingGenerationJob = await db.query.jobs.findFirst({
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
    job.payload.userId
  );

  await db
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
>) {
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
    await db
      .update(contentPacks)
      .set({
        transcriptId: sourceAsset.transcript.id,
        updatedAt: new Date(),
      })
      .where(eq(contentPacks.id, job.payload.contentPackId));
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

  if (sourceAsset.assetType === SourceAssetType.UPLOADED_FILE) {
    await enqueueTranscriptionJob(sourceAsset.id, job.payload.userId);
  } else if (sourceAsset.assetType === SourceAssetType.YOUTUBE_URL) {
    await enqueueYoutubeIngestionJob(sourceAsset.id, job.payload.userId);
  } else {
    throw new Error('This source asset type does not support clip generation.');
  }

  await db
    .update(contentPacks)
    .set({
      status: ContentPackStatus.GENERATING,
      failureReason: null,
      updatedAt: new Date(),
    })
    .where(eq(contentPacks.id, job.payload.contentPackId));
  await requeueJob(
    job.id,
    new Date(Date.now() + PIPELINE_TRANSCRIPT_WAIT_MS)
  );
  triggerInternalJobProcessing();

  return null;
}

export async function processNextJob() {
  const job = await claimNextJob();

  if (!job) {
    return {
      processed: false,
    };
  }

  try {
    const staleValidation = await validateJobFreshness(job);

    if (staleValidation) {
      await cancelStaleJob(job, staleValidation);
      triggerInternalJobProcessing();

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
        const transcript = await transcribeSourceAsset(job.payload.sourceAssetId);
        await wakeShortFormPackJobsForSourceAsset(
          job.payload.sourceAssetId,
          transcript.id
        );
        await markJobCompleted(job.id);
        triggerInternalJobProcessing();

        return {
          processed: true,
          jobId: job.id,
          jobType: job.type,
          sourceAssetId: job.payload.sourceAssetId,
          transcriptId: transcript.id,
          status: 'completed' as const,
        };
      }
      case JobType.INGEST_YOUTUBE_SOURCE_ASSET: {
        const transcript = await ingestYoutubeSourceAsset(job.payload.sourceAssetId);
        await wakeShortFormPackJobsForSourceAsset(
          job.payload.sourceAssetId,
          transcript.id
        );
        await markJobCompleted(job.id);
        triggerInternalJobProcessing();

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
        const transcript = await waitForTranscriptAndRequeueGeneration(job);

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

        const contentPack = await generateShortFormPack(
          job.payload.contentPackId,
          job.payload.generationRunId
        );
        await markJobCompleted(job.id);
        await reconcileShortFormContentPackStatus({
          contentPackId: contentPack.id,
          sourceAssetId: contentPack.sourceAssetId,
          generationRunId: contentPack.generationRunId,
        });
        triggerInternalJobProcessing();

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
        const renderedClip = await renderApprovedClipCandidate(
          job.payload.clipCandidateId,
          job.payload.captionsEnabled ?? true,
          job.payload.captionFontAssetId,
          { jobId: job.id }
        );
        await markJobCompleted(job.id);
        triggerInternalJobProcessing();

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
        const renderedClip = await formatRenderedClipShortFormCandidate(
          job.payload.clipCandidateId,
          job.payload.variant ?? RenderedClipVariant.VERTICAL_SHORT_FORM,
          job.payload.layout ?? RenderedClipLayout.DEFAULT,
          job.payload.captionsEnabled ?? true,
          job.payload.captionFontAssetId,
          job.payload.editConfigHash,
          { jobId: job.id }
        );
        await markJobCompleted(job.id);
        await reconcileShortFormContentPackStatus({
          contentPackId: job.payload.contentPackId,
          sourceAssetId: job.payload.sourceAssetId,
          generationRunId: job.payload.generationRunId,
        });
        triggerInternalJobProcessing();

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
        const result = await detectVideoFacecam(
          job.payload.videoId,
          job.payload.userId,
          { jobId: job.id }
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

          await enqueueShortFormPackJob(
            job.payload.contentPackId,
            job.payload.sourceAssetId,
            undefined,
            job.payload.userId
          );
          await markJobCompleted(job.id);
          triggerInternalJobProcessing();

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
          const editConfig = await applyFacecamResultToClipEditConfig({
            clipCandidateId: candidate.id,
            userId: job.payload.userId,
            generationRunId: candidate.generationRunId,
            status: result.status,
          });
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
            true,
            getFacecamFallbackQueueReason(result.status)
          );
        }

        if (job.payload.contentPackId && job.payload.generationRunId) {
          await reconcileShortFormContentPackStatus({
            contentPackId: job.payload.contentPackId,
            sourceAssetId: job.payload.sourceAssetId,
            generationRunId: job.payload.generationRunId,
          });
        }
        await markJobCompleted(job.id);
        triggerInternalJobProcessing();

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
        const publication = await publishRenderedClipPublication(
          job.payload.clipPublicationId
        );
        await markJobCompleted(job.id);
        triggerInternalJobProcessing();

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

      await cancelStaleJob(job, staleValidation);
      triggerInternalJobProcessing();

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

    logPipelineError(job.type, error, {
      jobId: job.id,
      sourceAssetId:
        'sourceAssetId' in job.payload ? job.payload.sourceAssetId : null,
      renderedClipId:
        'renderedClipId' in job.payload ? job.payload.renderedClipId : null,
      failureReason,
    });

    if (job.type === JobType.GENERATE_SHORT_FORM_PACK) {
      await markContentPackFailed(job.payload.contentPackId, failureReason);
    } else if (job.type === JobType.RENDER_CLIP_CANDIDATE) {
      await markRenderedClipFailed(
        job.payload.clipCandidateId,
        job.payload.userId,
        RenderedClipVariant.TRIMMED_ORIGINAL,
        failureReason
      );
    } else if (job.type === JobType.FORMAT_RENDERED_CLIP_SHORT_FORM) {
      await markRenderedClipFailed(
        job.payload.clipCandidateId,
        job.payload.userId,
        job.payload.variant ?? RenderedClipVariant.VERTICAL_SHORT_FORM,
        failureReason,
        job.payload.layout ?? RenderedClipLayout.DEFAULT
      );
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

          await enqueueShortFormPackJob(
            job.payload.contentPackId,
            job.payload.sourceAssetId,
            undefined,
            job.payload.userId
          );
          triggerInternalJobProcessing();
        }

        for (const candidate of candidates) {
          const editConfig = await applyFacecamResultToClipEditConfig({
            clipCandidateId: candidate.id,
            userId: job.payload.userId,
            generationRunId: candidate.generationRunId,
            status: facecamFailureStatus,
            failureReason,
            debugReason: debugFailureReason,
          });
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
            true,
            getFacecamFallbackQueueReason(facecamFailureStatus)
          );
        }

        if (job.payload.contentPackId && job.payload.generationRunId) {
          await reconcileShortFormContentPackStatus({
            contentPackId: job.payload.contentPackId,
            sourceAssetId: job.payload.sourceAssetId,
            generationRunId: job.payload.generationRunId,
          });
        }
        triggerInternalJobProcessing();
      } catch (fallbackError) {
        logPipelineError(job.type, fallbackError, {
          jobId: job.id,
          sourceAssetId: job.payload.sourceAssetId,
          failureReason: 'Facecam fallback render could not be queued.',
        });
      }
    } else if (job.type === JobType.PUBLISH_RENDERED_CLIP) {
      await markClipPublicationFailed(
        job.payload.clipPublicationId,
        failureReason
      );
    } else {
      await markTranscriptFailed(
        job.payload.sourceAssetId,
        job.payload.userId,
        failureReason
      );
      await wakeShortFormPackJobsForSourceAsset(job.payload.sourceAssetId);
    }

    await markJobFailed(job.id, failureReason);
    triggerInternalJobProcessing();

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
  }
}
