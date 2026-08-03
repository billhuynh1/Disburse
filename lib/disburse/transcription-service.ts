import 'server-only';

import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import {
  contentPacks,
  sourceAssets,
  SourceAssetStatus,
  SourceAssetType,
  TranscriptStatus,
} from '@/lib/db/schema';
import {
  transcribeWithOpenAI,
} from '@/lib/disburse/openai-transcription';
import {
  mergeTimestampedTranscriptionChunks,
  withPreparedTranscriptionChunks,
} from '@/lib/disburse/transcription-prep-service';
import {
  markTranscriptProcessing,
  upsertTranscriptReady,
} from '@/lib/disburse/transcript-service';
import { assertMediaAvailable } from '@/lib/disburse/media-retention-service';
import {
  assertJobExecutionAuthorized,
  type JobExecutionAuthority,
  withAuthorizedJobSuccessTransaction,
  withAuthorizedJobTransaction,
} from '@/lib/disburse/job-execution-authorization';
import { getJobOperationSignal } from '@/lib/disburse/pipeline-operation-deadline';

async function transcribePreparedSourceAsset(params: {
  storageKey: string;
  originalFilename: string;
  language: string | null;
  authority: JobExecutionAuthority;
}) {
  return await withPreparedTranscriptionChunks({
    storageKey: params.storageKey,
    originalFilename: params.originalFilename,
    signal: getJobOperationSignal(params.authority),
  }, async (chunks) => {
    const transcriptions = [];

    for (const chunk of chunks) {
      await assertJobExecutionAuthorized(params.authority);
      const transcription = await transcribeWithOpenAI({
        file: chunk.file,
        filename: chunk.filename,
        language: params.language,
        wordTimestamps: true,
        signal: getJobOperationSignal(params.authority),
      });

      transcriptions.push({
        sequence: chunk.sequence,
        startOffsetMs: chunk.startOffsetMs,
        text: transcription.text,
        language: transcription.language,
        segments: transcription.segments,
        words: transcription.words,
      });
    }

    return mergeTimestampedTranscriptionChunks(transcriptions);
  });
}

export type TranscriptionExternalOperations = {
  transcribe: typeof transcribePreparedSourceAsset;
};

const productionTranscriptionExternalOperations: TranscriptionExternalOperations = {
  transcribe: transcribePreparedSourceAsset,
};

export async function transcribeSourceAsset(
  sourceAssetId: number,
  authority: JobExecutionAuthority,
  external: TranscriptionExternalOperations = productionTranscriptionExternalOperations
) {
  const sourceAsset = await db.query.sourceAssets.findFirst({
    where: eq(sourceAssets.id, sourceAssetId),
    with: {
      transcript: {
        with: {
          segments: true,
          words: true,
        },
      },
    },
  });

  if (!sourceAsset) {
    throw new Error('Source asset not found.');
  }

  if (sourceAsset.assetType !== SourceAssetType.UPLOADED_FILE) {
    throw new Error('Only uploaded file source assets can be transcribed.');
  }

  if (!sourceAsset.storageKey || !sourceAsset.originalFilename) {
    throw new Error('Source asset is missing storage metadata.');
  }

  assertMediaAvailable(sourceAsset, 'Source asset');

  if (
    sourceAsset.transcript?.status === TranscriptStatus.READY &&
    sourceAsset.transcript.content &&
    sourceAsset.transcript.segments.length > 0
  ) {
    await withAuthorizedJobSuccessTransaction(authority, async (tx) => {
      if (sourceAsset.status !== SourceAssetStatus.READY) {
        const [updatedSourceAsset] = await tx
          .update(sourceAssets)
          .set({
            status: SourceAssetStatus.READY,
            failureReason: null,
            updatedAt: new Date(),
          })
          .where(eq(sourceAssets.id, sourceAsset.id))
          .returning({ id: sourceAssets.id });

        if (!updatedSourceAsset) {
          throw new Error('Source asset not found after transcript processing.');
        }
      }

      await tx
        .update(contentPacks)
        .set({
          transcriptId: sourceAsset.transcript!.id,
          updatedAt: new Date(),
        })
        .where(eq(contentPacks.sourceAssetId, sourceAsset.id));
    });

    return sourceAsset.transcript;
  }

  await withAuthorizedJobTransaction(authority, async (tx) => {
    await markTranscriptProcessing(sourceAsset.id, sourceAsset.userId, tx);
  });

  await assertJobExecutionAuthorized(authority);

  const transcription = await external.transcribe({
    storageKey: sourceAsset.storageKey,
    originalFilename: sourceAsset.originalFilename,
    language: sourceAsset.transcript?.language || null,
    authority,
  });

  return await withAuthorizedJobSuccessTransaction(authority, async (tx) => {
    return await upsertTranscriptReady({
      sourceAssetId: sourceAsset.id,
      userId: sourceAsset.userId,
      content: transcription.content,
      language: transcription.language,
      segments: transcription.segments,
      words: transcription.words,
    }, tx);
  });
}
