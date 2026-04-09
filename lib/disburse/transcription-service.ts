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
  assertTranscriptReadyState,
  markTranscriptProcessing,
  upsertTranscriptReady,
} from '@/lib/disburse/transcript-service';

export async function transcribeSourceAsset(sourceAssetId: number) {
  const sourceAsset = await db.query.sourceAssets.findFirst({
    where: eq(sourceAssets.id, sourceAssetId),
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

  if (sourceAsset.assetType !== SourceAssetType.UPLOADED_FILE) {
    throw new Error('Only uploaded file source assets can be transcribed.');
  }

  if (!sourceAsset.storageKey || !sourceAsset.originalFilename) {
    throw new Error('Source asset is missing storage metadata.');
  }

  if (
    sourceAsset.transcript?.status === TranscriptStatus.READY &&
    sourceAsset.transcript.content &&
    sourceAsset.transcript.segments.length > 0
  ) {
    if (sourceAsset.status !== SourceAssetStatus.READY) {
      await db
        .update(sourceAssets)
        .set({
          status: SourceAssetStatus.READY,
          failureReason: null,
          updatedAt: new Date(),
        })
        .where(eq(sourceAssets.id, sourceAsset.id));
    }

    await db
      .update(contentPacks)
      .set({
        transcriptId: sourceAsset.transcript.id,
        updatedAt: new Date(),
      })
      .where(eq(contentPacks.sourceAssetId, sourceAsset.id));

    return await assertTranscriptReadyState(sourceAsset.id);
  }

  await markTranscriptProcessing(sourceAsset.id, sourceAsset.userId);

  const transcription = await withPreparedTranscriptionChunks({
    storageKey: sourceAsset.storageKey,
    originalFilename: sourceAsset.originalFilename,
  }, async (chunks) => {
    const transcriptions = [];

    for (const chunk of chunks) {
      const transcription = await transcribeWithOpenAI({
        file: chunk.file,
        filename: chunk.filename,
        language: sourceAsset.transcript?.language || null,
      });

      transcriptions.push({
        sequence: chunk.sequence,
        startOffsetMs: chunk.startOffsetMs,
        text: transcription.text,
        language: transcription.language,
        segments: transcription.segments,
      });
    }

    return mergeTimestampedTranscriptionChunks(transcriptions);
  });

  await upsertTranscriptReady({
    sourceAssetId: sourceAsset.id,
    userId: sourceAsset.userId,
    content: transcription.content,
    language: transcription.language,
    segments: transcription.segments,
  });

  return await assertTranscriptReadyState(sourceAsset.id);
}
