import 'server-only';

import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import {
  contentPacks,
  sourceAssets,
  SourceAssetStatus,
  transcriptSegments,
  transcriptWords,
  transcripts,
  TranscriptStatus,
} from '@/lib/db/schema';
import type {
  TimestampedTranscriptSegment,
  TimestampedTranscriptWord,
} from '@/lib/disburse/openai-transcription';

function normalizeFailureReason(reason: string) {
  const normalized = reason.trim();
  return normalized.length > 0
    ? normalized.slice(0, 5000)
    : 'Transcript processing failed.';
}

export async function markTranscriptProcessing(
  sourceAssetId: number,
  userId: number
) {
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

export async function markTranscriptFailed(
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

export async function upsertTranscriptReady(params: {
  sourceAssetId: number;
  userId: number;
  content: string;
  language: string | null;
  segments: TimestampedTranscriptSegment[];
  words?: TimestampedTranscriptWord[];
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
      .delete(transcriptSegments)
      .where(eq(transcriptSegments.transcriptId, transcript.id));
    await tx
      .delete(transcriptWords)
      .where(eq(transcriptWords.transcriptId, transcript.id));

    if (params.segments.length > 0) {
      await tx.insert(transcriptSegments).values(
        params.segments.map((segment) => ({
          transcriptId: transcript.id,
          sequence: segment.sequence,
          startTimeMs: segment.startTimeMs,
          endTimeMs: segment.endTimeMs,
          text: segment.text,
          updatedAt: now,
        }))
      );
    }

    if (params.words && params.words.length > 0) {
      await tx.insert(transcriptWords).values(
        params.words.map((word) => ({
          transcriptId: transcript.id,
          sequence: word.sequence,
          startTimeMs: word.startTimeMs,
          endTimeMs: word.endTimeMs,
          text: word.text,
          updatedAt: now,
        }))
      );
    }

    const [sourceAsset] = await tx
      .update(sourceAssets)
      .set({
        status: SourceAssetStatus.READY,
        failureReason: null,
        updatedAt: now,
      })
      .where(eq(sourceAssets.id, params.sourceAssetId))
      .returning({ id: sourceAssets.id });

    if (!sourceAsset) {
      throw new Error('Source asset not found after transcript processing.');
    }

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

export async function assertTranscriptReadyState(sourceAssetId: number) {
  const sourceAsset = await db.query.sourceAssets.findFirst({
    where: eq(sourceAssets.id, sourceAssetId),
    with: {
      transcript: true,
    },
  });

  if (!sourceAsset) {
    throw new Error('Source asset not found after transcript processing.');
  }

  if (sourceAsset.status !== SourceAssetStatus.READY) {
    throw new Error('Source asset was not marked ready after transcript processing.');
  }

  if (
    !sourceAsset.transcript ||
    sourceAsset.transcript.status !== TranscriptStatus.READY ||
    !sourceAsset.transcript.content
  ) {
    throw new Error('Transcript was not marked ready after transcript processing.');
  }

  return sourceAsset.transcript;
}
