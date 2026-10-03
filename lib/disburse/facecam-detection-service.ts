import 'server-only';

import { and, asc, desc, eq, gte, lte } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import {
  clipCandidateFacecamDetectionRuns,
  clipCandidateFacecamDetections,
  clipCandidates,
  FacecamDetectionStatus,
  RenderedClipLayout,
  SourceAssetStatus,
  SourceAssetType,
  facecamSegments,
  sourceAssets,
  type FacecamSegment,
} from '@/lib/db/schema';
import { createPresignedDownload } from '@/lib/disburse/s3-storage';
import {
  detectFacecamRegions,
  getFacecamDetectionTimeoutMs,
  MediaApiFacecamDetectionError,
  type MediaApiFacecamErrorKind,
  type MediaApiFacecamDetectionResponse,
} from '@/lib/disburse/media-api-client';
import { assertMediaAvailable } from '@/lib/disburse/media-retention-service';
import { validateClipTiming } from '@/lib/disburse/clip-timing';
import {
  assertJobExecutionAuthorized,
  type JobExecutionAuthority,
  withAuthorizedJobSuccessTransaction,
  withAuthorizedJobTransaction,
} from '@/lib/disburse/job-execution-authorization';
import { getJobOperationSignal } from '@/lib/disburse/pipeline-operation-deadline';

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = typeof db | DbTransaction;

export const FACECAM_DETECTOR_VERSION = 'facecam_v1';
export const SNAPSHOT_FACECAM_DETECTOR_VERSION = 'facecam_v2';

function normalizeFailureReason(reason: string) {
  const normalized = reason.trim();
  return normalized.length > 0
    ? normalized.slice(0, 5000)
    : 'Facecam detection failed.';
}

export function buildFacecamIdempotencyKey(videoId: number) {
  return `facecam:${videoId}`;
}

export function buildCandidateFacecamIdempotencyKey(params: {
  sourceAssetId: number;
  clipCandidateId: number;
  startTimeMs: number;
  endTimeMs: number;
  detectorVersion?: string;
}) {
  return [
    `facecam:${params.sourceAssetId}`,
    `candidate:${params.clipCandidateId}`,
    `range:${params.startTimeMs}-${params.endTimeMs}`,
    `detector:${params.detectorVersion || FACECAM_DETECTOR_VERSION}`,
  ].join(':');
}

export function getFacecamFailureStatus(kind: MediaApiFacecamErrorKind) {
  switch (kind) {
    case 'timeout':
      return FacecamDetectionStatus.FAILED_TIMEOUT;
    case 'aborted':
      return FacecamDetectionStatus.FAILED_ABORTED;
    case 'network_error':
      return FacecamDetectionStatus.FAILED_NETWORK;
    case 'http_error':
      return FacecamDetectionStatus.FAILED_HTTP;
    case 'invalid_response':
      return FacecamDetectionStatus.FAILED_INVALID_RESPONSE;
  }
}

export function getFacecamFallbackQueueReason(status: FacecamDetectionStatus) {
  switch (status) {
    case FacecamDetectionStatus.NOT_FOUND:
      return 'facecam_not_detected';
    case FacecamDetectionStatus.FAILED_TIMEOUT:
      return 'facecam_detection_failed_timeout';
    case FacecamDetectionStatus.FAILED_ABORTED:
      return 'facecam_detection_failed_aborted';
    case FacecamDetectionStatus.FAILED_NETWORK:
      return 'facecam_detection_failed_network';
    case FacecamDetectionStatus.FAILED_HTTP:
      return 'facecam_detection_failed_http';
    case FacecamDetectionStatus.FAILED_INVALID_RESPONSE:
      return 'facecam_detection_failed_invalid_response';
    case FacecamDetectionStatus.FAILED:
      return 'facecam_detection_failed';
    default:
      return 'facecam_detection_completed';
  }
}

export function getFacecamFailureStatusForError(error: unknown) {
  return error instanceof MediaApiFacecamDetectionError
    ? getFacecamFailureStatus(error.kind)
    : FacecamDetectionStatus.FAILED;
}

async function getVideoForFacecam(videoId: number, userId: number) {
  return await db.query.sourceAssets.findFirst({
    where: and(eq(sourceAssets.id, videoId), eq(sourceAssets.userId, userId)),
    with: {
      transcript: {
        with: {
          segments: true,
        },
      },
    },
  });
}

function validateVideoForFacecam(
  video: Awaited<ReturnType<typeof getVideoForFacecam>>,
  userId: number
) {
  if (!video || video.userId !== userId) {
    throw new Error('Source video not found.');
  }

  if (video.assetType !== SourceAssetType.UPLOADED_FILE) {
    throw new Error('Facecam detection is only supported for uploaded videos right now.');
  }

  if (video.status !== SourceAssetStatus.READY) {
    throw new Error('This source video is not ready for facecam detection yet.');
  }

  if (video.mimeType && !video.mimeType.startsWith('video/')) {
    throw new Error('Facecam detection is only supported for uploaded videos right now.');
  }

  if (!video.storageKey || !video.originalFilename) {
    throw new Error('Source video is missing storage metadata.');
  }

  assertMediaAvailable(video, 'Source video');

  const durationMs = Math.max(
    0,
    ...(video.transcript?.segments || []).map((segment) => segment.endTimeMs)
  );

  if (durationMs <= 0) {
    throw new Error('A timestamped transcript is required for video-level facecam detection.');
  }

  return {
    video,
    durationMs,
  };
}

async function getCandidateForFacecam(clipCandidateId: number, userId: number) {
  return await db.query.clipCandidates.findFirst({
    where: and(
      eq(clipCandidates.id, clipCandidateId),
      eq(clipCandidates.userId, userId)
    ),
    with: {
      sourceAsset: true,
      contentPack: true,
    },
  });
}

function validateCandidateForFacecam(
  candidate: Awaited<ReturnType<typeof getCandidateForFacecam>>,
  params: {
    userId: number;
    sourceAssetId: number;
    contentPackId: number;
    generationRunId: string;
    startTimeMs: number;
    endTimeMs: number;
  }
) {
  if (!candidate || candidate.userId !== params.userId) {
    throw new Error('Clip candidate not found.');
  }

  if (
    candidate.sourceAssetId !== params.sourceAssetId ||
    candidate.contentPackId !== params.contentPackId ||
    candidate.generationRunId !== params.generationRunId ||
    candidate.contentPack.generationRunId !== params.generationRunId
  ) {
    throw new Error('Facecam detection job is stale for this clip candidate.');
  }

  if (candidate.sourceAsset.assetType !== SourceAssetType.UPLOADED_FILE) {
    throw new Error('Facecam detection is only supported for uploaded videos right now.');
  }

  if (candidate.sourceAsset.status !== SourceAssetStatus.READY) {
    throw new Error('This source video is not ready for facecam detection yet.');
  }

  if (
    candidate.sourceAsset.mimeType &&
    !candidate.sourceAsset.mimeType.startsWith('video/')
  ) {
    throw new Error('Facecam detection is only supported for uploaded videos right now.');
  }

  if (!candidate.sourceAsset.storageKey || !candidate.sourceAsset.originalFilename) {
    throw new Error('Source video is missing storage metadata.');
  }

  assertMediaAvailable(candidate.sourceAsset, 'Source video');

  const timing = validateClipTiming(
    {
      startTimeMs: candidate.startTimeMs,
      endTimeMs: candidate.endTimeMs,
      durationMs: candidate.durationMs,
    },
    'Facecam detection clip candidate timing'
  );

  if (
    timing.startTimeMs !== params.startTimeMs ||
    timing.endTimeMs !== params.endTimeMs
  ) {
    throw new Error('Facecam detection job timing is stale for this clip candidate.');
  }

  return {
    candidate,
    timing,
  };
}

export async function getFacecamSegmentsForVideo(
  videoId: number,
  userId: number,
  executor: DbLike = db
) {
  return await executor.query.facecamSegments.findMany({
    where: and(
      eq(facecamSegments.videoId, videoId),
      eq(facecamSegments.userId, userId)
    ),
    orderBy: (segments, { asc, desc }) => [
      desc(segments.confidence),
      asc(segments.rank),
    ],
  });
}

export async function getFacecamSegmentForClip(params: {
  videoId: number;
  userId: number;
  clipCandidateId?: number;
  startTimeMs: number;
  endTimeMs: number;
}): Promise<FacecamSegment | null> {
  const [segment] = await db
    .select()
    .from(facecamSegments)
    .where(
      and(
        eq(facecamSegments.videoId, params.videoId),
        eq(facecamSegments.userId, params.userId),
        lte(facecamSegments.startTimeMs, params.endTimeMs),
        gte(facecamSegments.endTimeMs, params.startTimeMs)
      )
    )
    .orderBy(desc(facecamSegments.confidence), asc(facecamSegments.rank))
    .limit(1);

  if (segment) {
    console.info('facecam_segments.reuse_for_render', {
      videoId: params.videoId,
      clipCandidateId: params.clipCandidateId ?? null,
      facecamSegmentId: segment.id,
      startTimeMs: params.startTimeMs,
      endTimeMs: params.endTimeMs,
    });
  }

  return segment || null;
}

export async function getFacecamDetectionForRender(params: {
  facecamDetectionId?: number | null;
  contentPackId?: number;
  sourceAssetId: number;
  userId: number;
  clipCandidateId: number;
  generationRunId: string;
  startTimeMs: number;
  endTimeMs: number;
  detectorVersion?: string;
  requireExactCandidateDetection?: boolean;
}, executor: DbLike = db) {
  if (params.requireExactCandidateDetection && (!params.facecamDetectionId || !params.contentPackId)) return null;
  const [candidateDetection] = await executor
    .select({
      id: clipCandidateFacecamDetections.id,
      frameWidth: clipCandidateFacecamDetections.frameWidth,
      frameHeight: clipCandidateFacecamDetections.frameHeight,
      xPx: clipCandidateFacecamDetections.xPx,
      yPx: clipCandidateFacecamDetections.yPx,
      widthPx: clipCandidateFacecamDetections.widthPx,
      heightPx: clipCandidateFacecamDetections.heightPx,
      confidence: clipCandidateFacecamDetections.confidence,
      rank: clipCandidateFacecamDetections.rank,
    })
    .from(clipCandidateFacecamDetections)
    .innerJoin(
      clipCandidateFacecamDetectionRuns,
      eq(
        clipCandidateFacecamDetections.detectionRunId,
        clipCandidateFacecamDetectionRuns.id
      )
    )
    .where(
      and(
        params.facecamDetectionId
          ? eq(clipCandidateFacecamDetections.id, params.facecamDetectionId)
          : undefined,
        eq(clipCandidateFacecamDetections.sourceAssetId, params.sourceAssetId),
        eq(clipCandidateFacecamDetections.userId, params.userId),
        eq(clipCandidateFacecamDetections.clipCandidateId, params.clipCandidateId),
        eq(clipCandidateFacecamDetections.generationRunId, params.generationRunId),
        eq(
          clipCandidateFacecamDetections.detectorVersion,
          params.detectorVersion || FACECAM_DETECTOR_VERSION
        ),
        eq(clipCandidateFacecamDetectionRuns.status, FacecamDetectionStatus.READY),
        ...(params.requireExactCandidateDetection ? [
          eq(clipCandidateFacecamDetections.startTimeMs, params.startTimeMs),
          eq(clipCandidateFacecamDetections.endTimeMs, params.endTimeMs),
          eq(clipCandidateFacecamDetectionRuns.contentPackId, params.contentPackId!),
          eq(clipCandidateFacecamDetectionRuns.userId, params.userId),
          eq(clipCandidateFacecamDetectionRuns.sourceAssetId, params.sourceAssetId),
          eq(clipCandidateFacecamDetectionRuns.clipCandidateId, params.clipCandidateId),
          eq(clipCandidateFacecamDetectionRuns.generationRunId, params.generationRunId),
          eq(clipCandidateFacecamDetectionRuns.detectorVersion, params.detectorVersion || FACECAM_DETECTOR_VERSION),
          eq(clipCandidateFacecamDetectionRuns.startTimeMs, params.startTimeMs),
          eq(clipCandidateFacecamDetectionRuns.endTimeMs, params.endTimeMs),
        ] : [])
      )
    )
    .orderBy(
      desc(clipCandidateFacecamDetections.confidence),
      asc(clipCandidateFacecamDetections.rank)
    )
    .limit(1);

  if (candidateDetection && params.requireExactCandidateDetection && (
    candidateDetection.frameWidth <= 0 || candidateDetection.frameHeight <= 0 ||
    candidateDetection.xPx < 0 || candidateDetection.yPx < 0 ||
    candidateDetection.widthPx <= 0 || candidateDetection.heightPx <= 0 ||
    candidateDetection.xPx + candidateDetection.widthPx > candidateDetection.frameWidth ||
    candidateDetection.yPx + candidateDetection.heightPx > candidateDetection.frameHeight
  )) return null;

  if (candidateDetection) {
    console.info('facecam_detection.reuse_candidate_for_render', {
      sourceAssetId: params.sourceAssetId,
      clipCandidateId: params.clipCandidateId,
      facecamDetectionId: candidateDetection.id,
      detectionSource: 'candidate_detection',
    });

    return {
      ...candidateDetection,
      detectionSource: 'candidate_detection' as const,
    };
  }

  if (params.facecamDetectionId || params.requireExactCandidateDetection) {
    return null;
  }

  const segment = await getFacecamSegmentForClip({
    videoId: params.sourceAssetId,
    userId: params.userId,
    clipCandidateId: params.clipCandidateId,
    startTimeMs: params.startTimeMs,
    endTimeMs: params.endTimeMs,
  });

  if (!segment) {
    return null;
  }

  console.info('facecam_detection.reuse_video_segment_for_render', {
    sourceAssetId: params.sourceAssetId,
    clipCandidateId: params.clipCandidateId,
    facecamSegmentId: segment.id,
    detectionSource: 'video_segment_fallback',
  });

  return {
    ...segment,
    detectionSource: 'video_segment_fallback' as const,
  };
}

async function saveCandidateFacecamDetectionResult(params: {
  detectionRunId: number;
  clipCandidateId: number;
  contentPackId: number;
  sourceAssetId: number;
  userId: number;
  generationRunId: string;
  detectorVersion: string;
  startTimeMs: number;
  endTimeMs: number;
  result: MediaApiFacecamDetectionResponse;
  jobId?: number;
  requestDurationMs?: number;
  timeoutMs?: number;
}, executor: DbLike = db) {
  const status =
    params.result.candidates.length > 0
      ? FacecamDetectionStatus.READY
      : FacecamDetectionStatus.NOT_FOUND;
  const now = new Date();

  const persist = async (tx: DbLike) => {
    await tx
      .delete(clipCandidateFacecamDetections)
      .where(
        eq(clipCandidateFacecamDetections.detectionRunId, params.detectionRunId)
      );

    if (params.result.candidates.length > 0) {
      await tx.insert(clipCandidateFacecamDetections).values(
        params.result.candidates.map((candidate) => ({
          userId: params.userId,
          sourceAssetId: params.sourceAssetId,
          clipCandidateId: params.clipCandidateId,
          detectionRunId: params.detectionRunId,
          generationRunId: params.generationRunId,
          detectorVersion: params.detectorVersion,
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
      .update(clipCandidateFacecamDetectionRuns)
      .set({
        status,
        failureReason: null,
        debugReason: null,
        sampledFrameCount: params.result.sampledFrameCount,
        detectionStage: params.result.detectionStage ?? null,
        debugSummary: params.result.debugSummary ?? null,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(clipCandidateFacecamDetectionRuns.id, params.detectionRunId));

    await tx
      .update(clipCandidates)
      .set({
        facecamDetectionStatus: status,
        facecamDetectionFailureReason: null,
        facecamDetectionDebugReason: null,
        facecamDetectedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(clipCandidates.id, params.clipCandidateId),
          eq(clipCandidates.userId, params.userId)
        )
      );
  };

  if (executor === db) {
    await db.transaction(async (tx) => await persist(tx));
  } else {
    await persist(executor);
  }

  console.info('candidate_facecam_detection_completed', {
    jobId: params.jobId ?? null,
    detectionRunId: params.detectionRunId,
    sourceAssetId: params.sourceAssetId,
    contentPackId: params.contentPackId,
    clipCandidateId: params.clipCandidateId,
    userId: params.userId,
    status,
    detectionCount: params.result.candidates.length,
    detectionStage: params.result.detectionStage ?? null,
    debugSummary: params.result.debugSummary ?? null,
    sampledFrameCount: params.result.sampledFrameCount,
    detectorVersion: params.detectorVersion,
    startTimeMs: params.startTimeMs,
    endTimeMs: params.endTimeMs,
    requestDurationMs: params.requestDurationMs ?? null,
    timeoutMs: params.timeoutMs ?? null,
  });

  return status;
}

async function saveVideoFacecamDetectionResult(params: {
  videoId: number;
  userId: number;
  startTimeMs: number;
  endTimeMs: number;
  result: MediaApiFacecamDetectionResponse;
  jobId?: number;
  requestDurationMs?: number;
  timeoutMs?: number;
}, executor: DbLike = db) {
  const status =
    params.result.candidates.length > 0
      ? FacecamDetectionStatus.READY
      : FacecamDetectionStatus.NOT_FOUND;

  if (params.result.candidates.length > 0) {
    await executor.insert(facecamSegments).values(
      params.result.candidates.map((candidate) => ({
        userId: params.userId,
        videoId: params.videoId,
        sourceAssetId: params.videoId,
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
        layoutType: RenderedClipLayout.FACECAM_TOP_40,
        sampledFrameCount: params.result.sampledFrameCount,
      }))
    );
  }

  console.info('facecam_detection_completed', {
    jobId: params.jobId ?? null,
    videoId: params.videoId,
    sourceAssetId: params.videoId,
    userId: params.userId,
    status,
    queueReason: getFacecamFallbackQueueReason(status),
    detectionCount: params.result.candidates.length,
    detectionStage: params.result.detectionStage ?? null,
    debugSummary: params.result.debugSummary ?? null,
    sampledFrameCount: params.result.sampledFrameCount,
    startTimeMs: params.startTimeMs,
    endTimeMs: params.endTimeMs,
    requestDurationMs: params.requestDurationMs ?? null,
    timeoutMs: params.timeoutMs ?? null,
  });

  return status;
}

export async function markVideoFacecamDetectionFailed(
  videoId: number,
  userId: number,
  reason: string,
  debugReason?: string,
  status: FacecamDetectionStatus = FacecamDetectionStatus.FAILED,
  context?: {
    jobId?: number;
    sourceAssetId?: number;
    timeoutMs?: number;
    requestDurationMs?: number;
    expectedAbort?: boolean;
    errorKind?: string;
  }
) {
  console.info('facecam_detection_completed', {
    jobId: context?.jobId ?? null,
    videoId,
    sourceAssetId: context?.sourceAssetId ?? videoId,
    userId,
    status,
    failureReason: normalizeFailureReason(reason),
    debugReason: debugReason?.trim().slice(0, 5000) || null,
    timeoutMs: context?.timeoutMs ?? null,
    requestDurationMs: context?.requestDurationMs ?? null,
    expectedAbort: context?.expectedAbort ?? null,
    errorKind: context?.errorKind ?? null,
  });
}

export async function markCandidateFacecamDetectionFailed(params: {
  detectionRunId?: number;
  clipCandidateId: number;
  userId: number;
  reason: string;
  debugReason?: string;
  status?: FacecamDetectionStatus;
  context?: {
    jobId?: number;
    sourceAssetId?: number;
    contentPackId?: number;
    timeoutMs?: number;
    requestDurationMs?: number;
    expectedAbort?: boolean;
    errorKind?: string;
  };
}, executor: DbLike = db) {
  const status = params.status || FacecamDetectionStatus.FAILED;
  const now = new Date();
  const failureReason = normalizeFailureReason(params.reason);
  const debugReason = params.debugReason?.trim().slice(0, 5000) || null;

  const persist = async (tx: DbLike) => {
    if (params.detectionRunId) {
      await tx
        .update(clipCandidateFacecamDetectionRuns)
        .set({
          status,
          failureReason,
          debugReason,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(clipCandidateFacecamDetectionRuns.id, params.detectionRunId));
    }

    await tx
      .update(clipCandidates)
      .set({
        facecamDetectionStatus: status,
        facecamDetectionFailureReason: failureReason,
        facecamDetectionDebugReason: debugReason,
        facecamDetectedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(clipCandidates.id, params.clipCandidateId),
          eq(clipCandidates.userId, params.userId)
        )
      );
  };

  if (executor === db) {
    await db.transaction(async (tx) => await persist(tx));
  } else {
    await persist(executor);
  }

  console.info('candidate_facecam_detection_completed', {
    jobId: params.context?.jobId ?? null,
    detectionRunId: params.detectionRunId ?? null,
    sourceAssetId: params.context?.sourceAssetId ?? null,
    contentPackId: params.context?.contentPackId ?? null,
    clipCandidateId: params.clipCandidateId,
    userId: params.userId,
    status,
    failureReason,
    debugReason,
    timeoutMs: params.context?.timeoutMs ?? null,
    requestDurationMs: params.context?.requestDurationMs ?? null,
    expectedAbort: params.context?.expectedAbort ?? null,
    errorKind: params.context?.errorKind ?? null,
  });
}

export type CandidateFacecamExternalOperations = {
  createDownload: typeof createPresignedDownload;
  detectRegions: typeof detectFacecamRegions;
};

const productionCandidateFacecamExternalOperations:
  CandidateFacecamExternalOperations = {
    createDownload: createPresignedDownload,
    detectRegions: detectFacecamRegions,
  };

export async function detectCandidateFacecam(params: {
  detectionRunId: number;
  clipCandidateId: number;
  contentPackId: number;
  sourceAssetId: number;
  userId: number;
  generationRunId: string;
  startTimeMs: number;
  endTimeMs: number;
  detectorVersion?: string;
  jobId?: number;
  authority: JobExecutionAuthority;
}, external: CandidateFacecamExternalOperations =
  productionCandidateFacecamExternalOperations) {
  const detectorVersion = params.detectorVersion || FACECAM_DETECTOR_VERSION;
  const detectionRun = await db.query.clipCandidateFacecamDetectionRuns.findFirst({
    where: and(
      eq(clipCandidateFacecamDetectionRuns.id, params.detectionRunId),
      eq(clipCandidateFacecamDetectionRuns.userId, params.userId),
      eq(clipCandidateFacecamDetectionRuns.clipCandidateId, params.clipCandidateId)
    ),
    with: {
      detections: true,
    },
  });

  if (!detectionRun) {
    throw new Error('Facecam detection run not found.');
  }

  if (
    detectionRun.status === FacecamDetectionStatus.READY &&
    detectionRun.detections.length > 0
  ) {
    console.info('candidate_facecam_detection.reuse_existing', {
      detectionRunId: detectionRun.id,
      clipCandidateId: params.clipCandidateId,
      sourceAssetId: params.sourceAssetId,
      detectorVersion,
      detectionCount: detectionRun.detections.length,
    });

    return {
      detectionRunId: detectionRun.id,
      clipCandidateId: params.clipCandidateId,
      status: FacecamDetectionStatus.READY,
      detectionCount: detectionRun.detections.length,
      skipped: true,
    };
  }

  const { candidate, timing } = validateCandidateForFacecam(
    await getCandidateForFacecam(params.clipCandidateId, params.userId),
    {
      userId: params.userId,
      sourceAssetId: params.sourceAssetId,
      contentPackId: params.contentPackId,
      generationRunId: params.generationRunId,
      startTimeMs: params.startTimeMs,
      endTimeMs: params.endTimeMs,
    }
  );
  const timeoutMs = getFacecamDetectionTimeoutMs();
  const now = new Date();

  await withAuthorizedJobTransaction(params.authority, async (tx) => {
    await tx
      .update(clipCandidateFacecamDetectionRuns)
      .set({
        status: FacecamDetectionStatus.DETECTING,
        jobId: params.jobId ?? detectionRun.jobId,
        startedAt: detectionRun.startedAt || now,
        completedAt: null,
        failureReason: null,
        debugReason: null,
        updatedAt: now,
      })
      .where(eq(clipCandidateFacecamDetectionRuns.id, params.detectionRunId));

    await tx
      .update(clipCandidates)
      .set({
        facecamDetectionStatus: FacecamDetectionStatus.DETECTING,
        facecamDetectionFailureReason: null,
        facecamDetectionDebugReason: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(clipCandidates.id, params.clipCandidateId),
          eq(clipCandidates.userId, params.userId)
        )
      );
  });

  console.info('candidate_facecam_detection_started', {
    jobId: params.jobId ?? null,
    detectionRunId: params.detectionRunId,
    sourceAssetId: params.sourceAssetId,
    contentPackId: params.contentPackId,
    clipCandidateId: params.clipCandidateId,
    userId: params.userId,
    detectorVersion,
    startTimeMs: timing.startTimeMs,
    endTimeMs: timing.endTimeMs,
    timeoutMs,
  });

  const download = external.createDownload({
    storageKey: candidate.sourceAsset.storageKey!,
  });
  const requestStartedAt = Date.now();
  await assertJobExecutionAuthorized(params.authority);
  const result = await external.detectRegions({
    sourceDownloadUrl: download.downloadUrl,
    sourceFilename: candidate.sourceAsset.originalFilename!,
    startTimeMs: timing.startTimeMs,
    endTimeMs: timing.endTimeMs,
    samplingIntervalMs: 500,
    detectorVersion,
  }, getJobOperationSignal(params.authority));
  const requestDurationMs = Date.now() - requestStartedAt;

  console.info('candidate_facecam_detection.result', {
    jobId: params.jobId ?? null,
    detectionRunId: params.detectionRunId,
    sourceAssetId: params.sourceAssetId,
    clipCandidateId: params.clipCandidateId,
    startTimeMs: timing.startTimeMs,
    endTimeMs: timing.endTimeMs,
    detectorVersion,
    requestDurationMs,
    timeoutMs,
    sampledFrameCount: result.sampledFrameCount,
    detectionCount: result.candidates.length,
  });

  const status = await withAuthorizedJobSuccessTransaction(params.authority, async (tx) =>
    await saveCandidateFacecamDetectionResult({
      detectionRunId: params.detectionRunId,
      clipCandidateId: params.clipCandidateId,
      contentPackId: params.contentPackId,
      sourceAssetId: params.sourceAssetId,
      userId: params.userId,
      generationRunId: params.generationRunId,
      detectorVersion,
      startTimeMs: timing.startTimeMs,
      endTimeMs: timing.endTimeMs,
      result,
      jobId: params.jobId,
      requestDurationMs,
      timeoutMs,
    }, tx)
  );

  return {
    detectionRunId: params.detectionRunId,
    clipCandidateId: params.clipCandidateId,
    status,
    detectionCount: result.candidates.length,
    skipped: false,
  };
}

export async function detectVideoFacecam(
  videoId: number,
  userId: number,
  context?: { jobId?: number; authority?: JobExecutionAuthority }
) {
  const existingSegments = await getFacecamSegmentsForVideo(videoId, userId);

  if (existingSegments.length > 0) {
    console.info('facecam_segments.reuse_existing', {
      videoId,
      userId,
      detectionCount: existingSegments.length,
    });

    return {
      videoId,
      status: FacecamDetectionStatus.READY,
      detectionCount: existingSegments.length,
      skipped: true,
    };
  }

  const { video, durationMs } = validateVideoForFacecam(
    await getVideoForFacecam(videoId, userId),
    userId
  );

  const timeoutMs = getFacecamDetectionTimeoutMs();

  console.info('facecam_detection_started', {
    jobId: context?.jobId ?? null,
    videoId,
    sourceAssetId: video.id,
    userId,
    timeoutMs,
    startTimeMs: 0,
    endTimeMs: durationMs,
    durationMs,
  });

  const download = createPresignedDownload({
    storageKey: video.storageKey!,
  });

  console.info('facecam_detection.request', {
    jobId: context?.jobId ?? null,
    videoId,
    userId,
    sourceAssetId: video.id,
    startTimeMs: 0,
    endTimeMs: durationMs,
    durationMs,
    timeoutMs,
  });

  const requestStartedAt = Date.now();
  if (!context?.authority) throw new Error('Job execution authority is required.');
  await assertJobExecutionAuthorized(context.authority);
  const result = await detectFacecamRegions({
    sourceDownloadUrl: download.downloadUrl,
    sourceFilename: video.originalFilename!,
    startTimeMs: 0,
    endTimeMs: durationMs,
    samplingIntervalMs: 500,
  }, getJobOperationSignal(context.authority));

  console.info('facecam_detection.result', {
    jobId: context?.jobId ?? null,
    videoId,
    sourceAssetId: video.id,
    startTimeMs: 0,
    endTimeMs: durationMs,
    requestDurationMs: Date.now() - requestStartedAt,
    timeoutMs,
    sampledFrameCount: result.sampledFrameCount,
    detectionCount: result.candidates.length,
  });

  const status = await withAuthorizedJobSuccessTransaction(context.authority, async (tx) =>
    await saveVideoFacecamDetectionResult({
      videoId,
      userId,
      startTimeMs: 0,
      endTimeMs: durationMs,
      result,
      jobId: context?.jobId,
      requestDurationMs: Date.now() - requestStartedAt,
      timeoutMs,
    }, tx)
  );

  return {
    videoId,
    status,
    detectionCount: result.candidates.length,
    skipped: false,
  };
}
