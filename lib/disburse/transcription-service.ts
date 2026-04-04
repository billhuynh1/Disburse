import 'server-only';

import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import {
  contentPacks,
  sourceAssets,
  SourceAssetStatus,
  SourceAssetType,
  transcripts,
  TranscriptStatus,
} from '@/lib/db/schema';
import {
  claimNextTranscriptionJob,
  markJobCompleted,
  markJobFailed,
} from '@/lib/disburse/job-service';
import {
  assertOpenAiTranscriptionSupport,
  transcribeWithOpenAI,
} from '@/lib/disburse/openai-transcription';
import { createPresignedDownload } from '@/lib/disburse/s3-storage';

function normalizeFailureReason(reason: string) {
  const normalized = reason.trim();
  return normalized.length > 0
    ? normalized.slice(0, 5000)
    : 'Transcription failed.';
}

async function markTranscriptProcessing(sourceAssetId: number, userId: number) {
  const now = new Date();

  await db
    .update(sourceAssets)
    .set({
      status: SourceAssetStatus.PROCESSING,
      failureReason: null,
      updatedAt: now,
    })
    .where(eq(sourceAssets.id, sourceAssetId));

  const [existingTranscript] = await db
    .select({ id: transcripts.id })
    .from(transcripts)
    .where(
      and(
        eq(transcripts.sourceAssetId, sourceAssetId),
        eq(transcripts.userId, userId)
      )
    )
    .limit(1);

  if (existingTranscript) {
    await db
      .update(transcripts)
      .set({
        status: TranscriptStatus.PROCESSING,
        failureReason: null,
        updatedAt: now,
      })
      .where(eq(transcripts.id, existingTranscript.id));

    return;
  }

  await db.insert(transcripts).values({
    userId,
    sourceAssetId,
    status: TranscriptStatus.PROCESSING,
  });
}

async function markTranscriptionFailed(
  sourceAssetId: number,
  userId: number,
  reason: string
) {
  const failureReason = normalizeFailureReason(reason);
  const now = new Date();

  await db
    .update(sourceAssets)
    .set({
      status: SourceAssetStatus.FAILED,
      failureReason,
      updatedAt: now,
    })
    .where(eq(sourceAssets.id, sourceAssetId));

  const [existingTranscript] = await db
    .select({ id: transcripts.id })
    .from(transcripts)
    .where(
      and(
        eq(transcripts.sourceAssetId, sourceAssetId),
        eq(transcripts.userId, userId)
      )
    )
    .limit(1);

  if (existingTranscript) {
    await db
      .update(transcripts)
      .set({
        status: TranscriptStatus.FAILED,
        failureReason,
        updatedAt: now,
      })
      .where(eq(transcripts.id, existingTranscript.id));

    return;
  }

  await db.insert(transcripts).values({
    userId,
    sourceAssetId,
    status: TranscriptStatus.FAILED,
    failureReason,
  });
}

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
    throw new Error(
      `Storage download failed with status ${response.status}.`
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  return new Blob([arrayBuffer], {
    type: params.mimeType || undefined,
  });
}

async function markTranscriptReady(params: {
  sourceAssetId: number;
  userId: number;
  content: string;
  language: string | null;
}) {
  return await db.transaction(async (tx) => {
    const now = new Date();
    const [transcript] = await tx
      .insert(transcripts)
      .values({
        userId: params.userId,
        sourceAssetId: params.sourceAssetId,
        language: params.language,
        content: params.content,
        status: TranscriptStatus.READY,
        failureReason: null,
      })
      .onConflictDoUpdate({
        target: transcripts.sourceAssetId,
        set: {
          language: params.language,
          content: params.content,
          status: TranscriptStatus.READY,
          failureReason: null,
          updatedAt: now,
        },
      })
      .returning();

    await tx
      .update(sourceAssets)
      .set({
        status: SourceAssetStatus.READY,
        failureReason: null,
        updatedAt: now,
      })
      .where(eq(sourceAssets.id, params.sourceAssetId));

    await tx
      .update(contentPacks)
      .set({
        transcriptId: transcript.id,
        updatedAt: now,
      })
      .where(eq(contentPacks.sourceAssetId, params.sourceAssetId));

    return transcript;
  });
}

export async function transcribeSourceAsset(sourceAssetId: number) {
  const sourceAsset = await db.query.sourceAssets.findFirst({
    where: eq(sourceAssets.id, sourceAssetId),
    with: {
      transcript: true,
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
    sourceAsset.transcript.content
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

    return sourceAsset.transcript;
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

  return await markTranscriptReady({
    sourceAssetId: sourceAsset.id,
    userId: sourceAsset.userId,
    content: transcription.text,
    language: transcription.language,
  });
}

export async function processNextJob() {
  const job = await claimNextTranscriptionJob();

  if (!job) {
    return {
      processed: false,
    };
  }

  try {
    const transcript = await transcribeSourceAsset(job.payload.sourceAssetId);
    await markJobCompleted(job.id);

    return {
      processed: true,
      jobId: job.id,
      sourceAssetId: job.payload.sourceAssetId,
      transcriptId: transcript.id,
      status: 'completed' as const,
    };
  } catch (error) {
    const failureReason =
      error instanceof Error ? error.message : 'Job processing failed.';

    await markTranscriptionFailed(
      job.payload.sourceAssetId,
      job.payload.userId,
      failureReason
    );
    await markJobFailed(job.id, failureReason);

    return {
      processed: true,
      jobId: job.id,
      sourceAssetId: job.payload.sourceAssetId,
      status: 'failed' as const,
      failureReason,
    };
  }
}
