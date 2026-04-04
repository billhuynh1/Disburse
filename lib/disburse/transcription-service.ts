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
  assertOpenAiTranscriptionSupport,
  transcribeWithOpenAI,
} from '@/lib/disburse/openai-transcription';
import { createPresignedDownload } from '@/lib/disburse/s3-storage';
import {
  assertTranscriptReadyState,
  markTranscriptProcessing,
  upsertTranscriptReady,
} from '@/lib/disburse/transcript-service';

async function downloadSourceAssetFile(params: {
  storageKey: string;
  mimeType: string | null;
}) {
  const download = createPresignedDownload({
    storageKey: params.storageKey,
  });
  const response = await fetch(download.downloadUrl, {
    method: download.method,
  });

  if (!response.ok) {
    throw new Error(`Storage download failed with status ${response.status}.`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return new Blob([arrayBuffer], {
    type: params.mimeType || undefined,
  });
}

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

  assertOpenAiTranscriptionSupport({
    filename: sourceAsset.originalFilename,
    fileSizeBytes: sourceAsset.fileSizeBytes,
  });

  const file = await downloadSourceAssetFile({
    storageKey: sourceAsset.storageKey,
    mimeType: sourceAsset.mimeType,
  });
  const transcription = await transcribeWithOpenAI({
    file,
    filename: sourceAsset.originalFilename,
    language: sourceAsset.transcript?.language || null,
  });

  await upsertTranscriptReady({
    sourceAssetId: sourceAsset.id,
    userId: sourceAsset.userId,
    content: transcription.text,
    language: transcription.language,
    segments: transcription.segments,
  });

  return await assertTranscriptReadyState(sourceAsset.id);
}
