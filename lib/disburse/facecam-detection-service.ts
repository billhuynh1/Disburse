import 'server-only';

import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import {
  clipCandidateFacecamDetections,
  clipCandidates,
  ContentPackKind,
  FacecamDetectionStatus,
  SourceAssetStatus,
  SourceAssetType,
} from '@/lib/db/schema';
import { createPresignedDownload } from '@/lib/disburse/s3-storage';
import {
  detectFacecamRegions,
  type MediaApiFacecamDetectionResponse,
} from '@/lib/disburse/media-api-client';

function normalizeFailureReason(reason: string) {
  const normalized = reason.trim();
  return normalized.length > 0
    ? normalized.slice(0, 5000)
    : 'Facecam detection failed.';
}

async function getClipCandidateForFacecam(clipCandidateId: number) {
  return await db.query.clipCandidates.findFirst({
    where: eq(clipCandidates.id, clipCandidateId),
    with: {
      contentPack: true,
      sourceAsset: true,
      facecamDetections: true,
    },
  });
}

function validateClipCandidateForFacecam(
  clipCandidate: Awaited<ReturnType<typeof getClipCandidateForFacecam>>,
  userId: number
) {
  if (!clipCandidate || clipCandidate.userId !== userId) {
    throw new Error('Clip candidate not found.');
  }

  if (clipCandidate.contentPack.kind !== ContentPackKind.SHORT_FORM_CLIPS) {
    throw new Error('Only short-form clip candidates can be analyzed.');
  }

  if (clipCandidate.sourceAsset.assetType !== SourceAssetType.UPLOADED_FILE) {
    throw new Error('Facecam detection is only supported for uploaded videos right now.');
  }

  if (clipCandidate.sourceAsset.status !== SourceAssetStatus.READY) {
    throw new Error('This source asset is not ready for facecam detection yet.');
  }

  if (
    clipCandidate.sourceAsset.mimeType &&
    !clipCandidate.sourceAsset.mimeType.startsWith('video/')
  ) {
    throw new Error('Facecam detection is only supported for uploaded videos right now.');
  }

  if (
    !clipCandidate.sourceAsset.storageKey ||
    !clipCandidate.sourceAsset.originalFilename
  ) {
    throw new Error('Source asset is missing storage metadata.');
  }

  return clipCandidate;
}

export async function ensureFacecamDetectionPending(params: {
  clipCandidateId: number;
  userId: number;
}) {
  const clipCandidate = validateClipCandidateForFacecam(
    await getClipCandidateForFacecam(params.clipCandidateId),
    params.userId
  );

  await db.transaction(async (tx) => {
    await tx
      .delete(clipCandidateFacecamDetections)
      .where(
        and(
          eq(
            clipCandidateFacecamDetections.clipCandidateId,
            params.clipCandidateId
          ),
          eq(clipCandidateFacecamDetections.userId, params.userId)
        )
      );

    await tx
      .update(clipCandidates)
      .set({
        facecamDetectionStatus: FacecamDetectionStatus.PENDING,
        facecamDetectionFailureReason: null,
        facecamDetectedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(clipCandidates.id, params.clipCandidateId));
  });

  return clipCandidate;
}

async function markFacecamDetectionDetecting(clipCandidateId: number) {
  await db
    .update(clipCandidates)
    .set({
      facecamDetectionStatus: FacecamDetectionStatus.DETECTING,
      facecamDetectionFailureReason: null,
      updatedAt: new Date(),
    })
    .where(eq(clipCandidates.id, clipCandidateId));
}

export async function markFacecamDetectionFailed(
  clipCandidateId: number,
  userId: number,
  reason: string
) {
  await db
    .update(clipCandidates)
    .set({
      facecamDetectionStatus: FacecamDetectionStatus.FAILED,
      facecamDetectionFailureReason: normalizeFailureReason(reason),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(clipCandidates.id, clipCandidateId),
        eq(clipCandidates.userId, userId)
      )
    );
}

async function saveFacecamDetectionResult(params: {
  clipCandidateId: number;
  userId: number;
  sourceAssetId: number;
  startTimeMs: number;
  endTimeMs: number;
  result: MediaApiFacecamDetectionResponse;
}) {
  const status =
    params.result.candidates.length > 0
      ? FacecamDetectionStatus.READY
      : FacecamDetectionStatus.NOT_FOUND;

  await db.transaction(async (tx) => {
    await tx
      .delete(clipCandidateFacecamDetections)
      .where(
        and(
          eq(
            clipCandidateFacecamDetections.clipCandidateId,
            params.clipCandidateId
          ),
          eq(clipCandidateFacecamDetections.userId, params.userId)
        )
      );

    if (params.result.candidates.length > 0) {
      await tx.insert(clipCandidateFacecamDetections).values(
        params.result.candidates.map((candidate) => ({
          userId: params.userId,
          sourceAssetId: params.sourceAssetId,
          clipCandidateId: params.clipCandidateId,
          rank: candidate.rank,
          startTimeMs: params.startTimeMs,
          endTimeMs: params.endTimeMs,
          frameWidth: params.result.frameWidth,
          frameHeight: params.result.frameHeight,
          xPx: candidate.xPx,
          yPx: candidate.yPx,
          widthPx: candidate.widthPx,
          heightPx: candidate.heightPx,
          confidence: candidate.confidence,
          sampledFrameCount: params.result.sampledFrameCount,
        }))
      );
    }

    await tx
      .update(clipCandidates)
      .set({
        facecamDetectionStatus: status,
        facecamDetectionFailureReason: null,
        facecamDetectedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(clipCandidates.id, params.clipCandidateId));
  });

  return status;
}

export async function detectClipCandidateFacecam(
  clipCandidateId: number,
  userId: number
) {
  const clipCandidate = validateClipCandidateForFacecam(
    await getClipCandidateForFacecam(clipCandidateId),
    userId
  );

  await markFacecamDetectionDetecting(clipCandidate.id);

  const download = createPresignedDownload({
    storageKey: clipCandidate.sourceAsset.storageKey!,
  });
  const result = await detectFacecamRegions({
    sourceDownloadUrl: download.downloadUrl,
    sourceFilename: clipCandidate.sourceAsset.originalFilename!,
    startTimeMs: clipCandidate.startTimeMs,
    endTimeMs: clipCandidate.endTimeMs,
  });

  const status = await saveFacecamDetectionResult({
    clipCandidateId: clipCandidate.id,
    userId: clipCandidate.userId,
    sourceAssetId: clipCandidate.sourceAssetId,
    startTimeMs: clipCandidate.startTimeMs,
    endTimeMs: clipCandidate.endTimeMs,
    result,
  });

  return {
    clipCandidateId: clipCandidate.id,
    status,
    detectionCount: result.candidates.length,
  };
}
