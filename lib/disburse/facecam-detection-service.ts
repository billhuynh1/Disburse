import 'server-only';

import { and, asc, desc, eq, gte, lte } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import {
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

function normalizeFailureReason(reason: string) {
  const normalized = reason.trim();
  return normalized.length > 0
    ? normalized.slice(0, 5000)
    : 'Facecam detection failed.';
}

export function buildFacecamIdempotencyKey(videoId: number) {
  return `facecam:${videoId}`;
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

export async function getFacecamSegmentsForVideo(videoId: number, userId: number) {
  return await db.query.facecamSegments.findMany({
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

async function saveVideoFacecamDetectionResult(params: {
  videoId: number;
  userId: number;
  startTimeMs: number;
  endTimeMs: number;
  result: MediaApiFacecamDetectionResponse;
  jobId?: number;
  requestDurationMs?: number;
  timeoutMs?: number;
}) {
  const status =
    params.result.candidates.length > 0
      ? FacecamDetectionStatus.READY
      : FacecamDetectionStatus.NOT_FOUND;

  if (params.result.candidates.length > 0) {
    await db.insert(facecamSegments).values(
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

export async function detectVideoFacecam(
  videoId: number,
  userId: number,
  context?: { jobId?: number }
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
  const result = await detectFacecamRegions({
    sourceDownloadUrl: download.downloadUrl,
    sourceFilename: video.originalFilename!,
    startTimeMs: 0,
    endTimeMs: durationMs,
    samplingIntervalMs: 500,
  });

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

  const status = await saveVideoFacecamDetectionResult({
    videoId,
    userId,
    startTimeMs: 0,
    endTimeMs: durationMs,
    result,
    jobId: context?.jobId,
    requestDurationMs: Date.now() - requestStartedAt,
    timeoutMs,
  });

  return {
    videoId,
    status,
    detectionCount: result.candidates.length,
    skipped: false,
  };
}
