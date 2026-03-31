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
import { generateShortFormPack, markContentPackFailed } from '@/lib/disburse/short-form-service';
import { markTranscriptFailed } from '@/lib/disburse/transcript-service';
import { transcribeSourceAsset } from '@/lib/disburse/transcription-service';
import { ingestYoutubeSourceAsset } from '@/lib/disburse/youtube-ingestion-service';
import { JobType } from '@/lib/db/schema';

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
    }
  } catch (error) {
    logPipelineError(job.type, error, {
      jobId: job.id,
      sourceAssetId: job.payload.sourceAssetId,
    });
    const failureReason = getUserSafePipelineFailureReason(job.type, error);

    if (job.type === JobType.GENERATE_SHORT_FORM_PACK) {
      await markContentPackFailed(job.payload.contentPackId, failureReason);
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
