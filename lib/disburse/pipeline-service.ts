import 'server-only';

import {
  claimNextJob,
  markJobCompleted,
  markJobFailed,
} from '@/lib/disburse/job-service';
import {
  getUserSafePipelineFailureReason,
  logPipelineError,
} from '@/lib/disburse/pipeline-errors';
import {
  formatRenderedClipShortFormCandidate,
  markRenderedClipFailed,
  renderApprovedClipCandidate,
} from '@/lib/disburse/rendered-clip-service';
import { generateShortFormPack, markContentPackFailed } from '@/lib/disburse/short-form-service';
import { markTranscriptFailed } from '@/lib/disburse/transcript-service';
import { transcribeSourceAsset } from '@/lib/disburse/transcription-service';
import { ingestYoutubeSourceAsset } from '@/lib/disburse/youtube-ingestion-service';
import { JobType, RenderedClipVariant } from '@/lib/db/schema';

export async function processNextJob() {
  const job = await claimNextJob();

  if (!job) {
    return {
      processed: false,
    };
  }

  try {
    switch (job.type) {
      case JobType.TRANSCRIBE_SOURCE_ASSET: {
        const transcript = await transcribeSourceAsset(job.payload.sourceAssetId);
        await markJobCompleted(job.id);

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
        await markJobCompleted(job.id);

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
        const contentPack = await generateShortFormPack(job.payload.contentPackId);
        await markJobCompleted(job.id);

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
          job.payload.clipCandidateId
        );
        await markJobCompleted(job.id);

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
          job.payload.clipCandidateId
        );
        await markJobCompleted(job.id);

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
    }
  } catch (error) {
    const failureReason = getUserSafePipelineFailureReason(job.type, error);

    logPipelineError(job.type, error, {
      jobId: job.id,
      sourceAssetId: job.payload.sourceAssetId,
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
        RenderedClipVariant.VERTICAL_SHORT_FORM,
        failureReason
      );
    } else {
      await markTranscriptFailed(
        job.payload.sourceAssetId,
        job.payload.userId,
        failureReason
      );
    }

    await markJobFailed(job.id, failureReason);

    return {
      processed: true,
      jobId: job.id,
      jobType: job.type,
      sourceAssetId: job.payload.sourceAssetId,
      status: 'failed' as const,
      failureReason,
    };
  }
}
