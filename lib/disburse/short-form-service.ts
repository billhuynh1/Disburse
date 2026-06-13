import 'server-only';

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import {
  clipCandidateFacecamDetections,
  clipCandidates,
  clipEditConfigs,
  clipPublications,
  contentPacks,
  ContentPackKind,
  ContentPackStatus,
  FacecamDetectionStatus,
  generatedAssets,
  jobs,
  JobStatus,
  JobType,
  RenderedClipLayout,
  RenderedClipStatus,
  RenderedClipVariant,
  renderedClips,
  sourceAssets,
  SourceAssetType,
  transcripts,
  type TranscriptSegment,
} from '@/lib/db/schema';
import {
  rankShortFormClipWindows,
  type ClipCandidateWindow,
  type RankedClipCandidate,
} from '@/lib/disburse/openai-short-form';
import { getRecoverableShortFormPackStatus } from '@/lib/disburse/short-form-pack-recovery';
import {
  applyFacecamResultToClipEditConfig,
  ensureDefaultClipEditConfigs,
  getRenderedClipVariantForEditConfig,
} from '@/lib/disburse/clip-edit-config-service';
import {
  packageCreatesGeneratedAssets,
  PACKAGE_GENERATED_ASSET_TYPES,
  parseContentPackageFromInstructions
} from '@/lib/disburse/content-package-config';
import { generatePackageAssets } from '@/lib/disburse/openai-package-assets';
import {
  getShortFormClipWindowConfig,
  parseShortFormAutoHookEnabledFromInstructions,
  parseShortFormClipLengthFromInstructions,
} from '@/lib/disburse/short-form-setup-config';
import {
  cancelShortFormPipelineJobsForContentPack,
  enqueueDetectVideoFacecamJob,
  enqueueFormatRenderedClipShortFormJob,
} from '@/lib/disburse/job-service';
import {
  createShortFormPackFailedNotification,
  createShortFormPackReadyNotification,
} from '@/lib/disburse/notification-service';
import { isUploadedVideoSource } from '@/lib/disburse/facecam-render-gate';
import { createGenerationRunId } from '@/lib/disburse/generation-run-service';
import {
  buildFacecamIdempotencyKey,
  getFacecamSegmentsForVideo,
} from '@/lib/disburse/facecam-detection-service';
import { StaleJobReason } from '@/lib/disburse/stale-job';
import { validateClipTiming } from '@/lib/disburse/clip-timing';

const MAX_WINDOWS = 72;
const SHORT_SOURCE_DURATION_MS = 5 * 60 * 1000;
const LONG_SOURCE_DURATION_MS = 20 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_CANDIDATES = 15;
const LONG_SOURCE_MAX_OUTPUT_CANDIDATES = 20;
const ACTIVE_FACECAM_DETECTION_STATUSES = new Set<string>([
  FacecamDetectionStatus.NOT_STARTED,
  FacecamDetectionStatus.PENDING,
  FacecamDetectionStatus.DETECTING,
]);

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type ShortFormPackWithArtifacts = Awaited<
  ReturnType<typeof getShortFormPackWithArtifacts>
>;

type ReconcileShortFormContentPackStatusParams = {
  contentPackId: number;
  sourceAssetId: number;
  generationRunId: string;
};

function logClipCandidateCreated(candidate: {
  id: number;
  userId: number;
  contentPackId: number;
  sourceAssetId: number;
  generationRunId: string;
  rank: number;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
}) {
  console.info('candidate_created', {
    clipCandidateId: candidate.id,
    userId: candidate.userId,
    contentPackId: candidate.contentPackId,
    sourceAssetId: candidate.sourceAssetId,
    generationRunId: candidate.generationRunId,
    rank: candidate.rank,
    startTimeMs: candidate.startTimeMs,
    endTimeMs: candidate.endTimeMs,
    durationMs: candidate.durationMs,
  });
}

function logClipEditConfigCreated(config: {
  id: number;
  userId: number;
  contentPackId: number;
  sourceAssetId: number;
  clipCandidateId: number;
  configHash: string;
}) {
  console.info('edit_config_created', {
    editConfigId: config.id,
    clipCandidateId: config.clipCandidateId,
    userId: config.userId,
    contentPackId: config.contentPackId,
    sourceAssetId: config.sourceAssetId,
    configHash: config.configHash,
  });
}

function buildShortFormPackName(sourceTitle: string) {
  return `${sourceTitle} Short Clips`;
}

function getTranscriptDurationMs(segments: TranscriptSegment[]) {
  return segments.reduce(
    (maxDurationMs, segment) => Math.max(maxDurationMs, segment.endTimeMs),
    0
  );
}

function getTargetCandidateRange(transcriptDurationMs: number) {
  if (transcriptDurationMs < SHORT_SOURCE_DURATION_MS) {
    return {
      min: 5,
      max: 8,
    };
  }

  if (transcriptDurationMs <= LONG_SOURCE_DURATION_MS) {
    return {
      min: 8,
      max: DEFAULT_MAX_OUTPUT_CANDIDATES,
    };
  }

  return {
    min: 12,
    max: LONG_SOURCE_MAX_OUTPUT_CANDIDATES,
  };
}

function createWindowId(index: number) {
  return `window-${index + 1}`;
}

function buildCandidateWindows(
  segments: TranscriptSegment[],
  clipWindowConfig: ReturnType<typeof getShortFormClipWindowConfig>
) {
  const windows: ClipCandidateWindow[] = [];

  for (let startIndex = 0; startIndex < segments.length; startIndex += 2) {
    const firstSegment = segments[startIndex];

    if (!firstSegment) {
      continue;
    }

    let excerptParts: string[] = [];
    let endTimeMs = firstSegment.endTimeMs;

    for (let currentIndex = startIndex; currentIndex < segments.length; currentIndex += 1) {
      const segment = segments[currentIndex];

      if (!segment) {
        break;
      }

      const nextParts = [...excerptParts, segment.text];
      const nextExcerpt = nextParts.join(' ').trim();
      const nextDurationMs = segment.endTimeMs - firstSegment.startTimeMs;

      if (nextExcerpt.length > clipWindowConfig.maxExcerptChars) {
        break;
      }

      excerptParts = nextParts;
      endTimeMs = segment.endTimeMs;

      if (nextDurationMs >= clipWindowConfig.targetDurationMs) {
        break;
      }

      if (nextDurationMs >= clipWindowConfig.maxDurationMs) {
        break;
      }
    }

    const transcriptExcerpt = excerptParts.join(' ').trim();
    const durationMs = endTimeMs - firstSegment.startTimeMs;

    if (
      transcriptExcerpt.length === 0 ||
      durationMs < clipWindowConfig.minDurationMs ||
      durationMs > clipWindowConfig.maxDurationMs
    ) {
      continue;
    }

    windows.push({
      id: createWindowId(windows.length),
      ...validateClipTiming(
        {
          startTimeMs: firstSegment.startTimeMs,
          endTimeMs,
          durationMs,
        },
        'Generated clip window'
      ),
      transcriptExcerpt,
    });

    if (windows.length >= MAX_WINDOWS) {
      break;
    }
  }

  return windows;
}

function computeOverlapRatio(
  left: Pick<ClipCandidateWindow, 'startTimeMs' | 'endTimeMs'>,
  right: Pick<ClipCandidateWindow, 'startTimeMs' | 'endTimeMs'>
) {
  const overlap = Math.max(
    0,
    Math.min(left.endTimeMs, right.endTimeMs) -
      Math.max(left.startTimeMs, right.startTimeMs)
  );
  const smallerDuration = Math.min(
    left.endTimeMs - left.startTimeMs,
    right.endTimeMs - right.startTimeMs
  );

  if (smallerDuration <= 0) {
    return 0;
  }

  return overlap / smallerDuration;
}

function dedupeRankedCandidates(
  rankedCandidates: RankedClipCandidate[],
  windowsById: Map<string, ClipCandidateWindow>,
  maxOutputCandidates: number
) {
  const selected: RankedClipCandidate[] = [];

  for (const candidate of rankedCandidates) {
    const window = windowsById.get(candidate.windowId);

    if (!window) {
      continue;
    }

    const overlapsExisting = selected.some((selectedCandidate) => {
      const selectedWindow = windowsById.get(selectedCandidate.windowId);

      return (
        selectedWindow &&
        computeOverlapRatio(window, selectedWindow) >= 0.65
      );
    });

    if (!overlapsExisting) {
      selected.push(candidate);
    }

    if (selected.length >= maxOutputCandidates) {
      break;
    }
  }

  return selected;
}

export async function ensureShortFormContentPack(params: {
  projectId: number;
  sourceAssetId: number;
  transcriptId?: number;
  userId: number;
  instructions?: string | null;
}) {
  const existingPack = await db.query.contentPacks.findFirst({
    where: and(
      eq(contentPacks.projectId, params.projectId),
      eq(contentPacks.sourceAssetId, params.sourceAssetId),
      eq(contentPacks.userId, params.userId),
      eq(contentPacks.kind, ContentPackKind.SHORT_FORM_CLIPS)
    ),
  });

  if (existingPack) {
    const [updatedPack] = await db
      .update(contentPacks)
      .set({
        ...(params.transcriptId ? { transcriptId: params.transcriptId } : {}),
        instructions: params.instructions ?? existingPack.instructions,
        failureReason: null,
        updatedAt: new Date(),
      })
      .where(eq(contentPacks.id, existingPack.id))
      .returning();

    return updatedPack;
  }

  const [sourceAsset] = await db
    .select({
      title: sourceAssets.title,
    })
    .from(sourceAssets)
    .where(eq(sourceAssets.id, params.sourceAssetId))
    .limit(1);

  if (!sourceAsset) {
    throw new Error('Source asset not found.');
  }

  const [contentPack] = await db
    .insert(contentPacks)
    .values({
      userId: params.userId,
      projectId: params.projectId,
      sourceAssetId: params.sourceAssetId,
      transcriptId: params.transcriptId ?? null,
      kind: ContentPackKind.SHORT_FORM_CLIPS,
      name: buildShortFormPackName(sourceAsset.title),
      generationRunId: createGenerationRunId(),
      instructions:
        params.instructions ||
        'AI-ranked short-form clip candidates for distribution across Shorts, TikTok, and Reels.',
      status: ContentPackStatus.PENDING,
    })
    .returning();

  return contentPack;
}

async function markContentPackGenerating(
  contentPackId: number,
  transcriptId: number,
  generationRunId?: string
) {
  await db
    .update(contentPacks)
    .set({
      status: ContentPackStatus.GENERATING,
      transcriptId,
      ...(generationRunId ? { generationRunId } : {}),
      failureReason: null,
      updatedAt: new Date(),
    })
    .where(eq(contentPacks.id, contentPackId));
}

export async function markContentPackFailed(contentPackId: number, reason: string) {
  const recoveredPack = await recoverShortFormPackBeforeFailure(contentPackId);

  if (recoveredPack) {
    console.info('short_form_pack.failure_recovered', {
      contentPackId,
      status: recoveredPack.status,
      sourceAssetId: recoveredPack.sourceAssetId,
      generationRunId: recoveredPack.generationRunId,
    });
    return;
  }

  await db
    .update(contentPacks)
    .set({
      status: ContentPackStatus.FAILED,
      failureReason: reason.trim().slice(0, 5000) || 'Short-form generation failed.',
      updatedAt: new Date(),
    })
    .where(eq(contentPacks.id, contentPackId));

  await createShortFormPackFailedNotification(contentPackId);
}

async function getShortFormPackWithArtifacts(contentPackId: number) {
  return await db.query.contentPacks.findFirst({
    where: eq(contentPacks.id, contentPackId),
    with: {
      sourceAsset: true,
      clipCandidates: {
        with: {
          editConfig: true,
          renderedClips: true,
        },
      },
    },
  });
}

function getCurrentGenerationClipCandidates(contentPack: NonNullable<ShortFormPackWithArtifacts>) {
  return contentPack.clipCandidates.filter(
    (candidate) => candidate.generationRunId === contentPack.generationRunId
  );
}

async function updateShortFormPackStatusIfChanged(
  contentPack: NonNullable<ShortFormPackWithArtifacts>,
  status: ContentPackStatus,
  failureReason: string | null
) {
  if (
    contentPack.status === status &&
    (contentPack.failureReason ?? null) === failureReason
  ) {
    return contentPack;
  }

  const [updatedPack] = await db
    .update(contentPacks)
    .set({
      status,
      failureReason,
      updatedAt: new Date(),
    })
    .where(eq(contentPacks.id, contentPack.id))
    .returning();

  return updatedPack;
}

async function hasActiveShortFormCandidateProcessing(contentPack: NonNullable<ShortFormPackWithArtifacts>) {
  const activeFacecamDetection =
    contentPack.sourceAsset.assetType === SourceAssetType.UPLOADED_FILE
      ? Boolean(
          await db.query.jobs.findFirst({
            where: and(
              eq(jobs.type, JobType.DETECT_CLIP_FACECAM),
              inArray(jobs.status, [JobStatus.PENDING, JobStatus.PROCESSING]),
              eq(
                jobs.idempotencyKey,
                buildFacecamIdempotencyKey(contentPack.sourceAssetId)
              )
            ),
          })
        )
      : false;
  const activeRender = Boolean(
    await db.query.jobs.findFirst({
      where: and(
        inArray(jobs.type, [
          JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
          JobType.RENDER_CLIP_CANDIDATE,
        ]),
        inArray(jobs.status, [JobStatus.PENDING, JobStatus.PROCESSING]),
        sql<boolean>`payload->>'contentPackId' = ${String(contentPack.id)}`,
        sql<boolean>`coalesce(payload->>'generationRunId', '') = ${contentPack.generationRunId}`
      ),
    })
  );

  return activeFacecamDetection || activeRender;
}

async function recoverShortFormPackBeforeFailure(contentPackId: number) {
  const contentPack = await getShortFormPackWithArtifacts(contentPackId);

  if (!contentPack || contentPack.kind !== ContentPackKind.SHORT_FORM_CLIPS) {
    return null;
  }

  const currentCandidates = getCurrentGenerationClipCandidates(contentPack);

  if (currentCandidates.length === 0) {
    return null;
  }

  const recoverableStatus = getRecoverableShortFormPackStatus({
    sourceAssetType: contentPack.sourceAsset.assetType,
    currentGenerationCandidateCount: currentCandidates.length,
    hasActiveProcessing: await hasActiveShortFormCandidateProcessing(contentPack),
  });

  if (!recoverableStatus) {
    return null;
  }

  if (recoverableStatus === ContentPackStatus.READY) {
    const [updatedPack] = await db
      .update(contentPacks)
      .set({
        status: recoverableStatus,
        failureReason: null,
        updatedAt: new Date(),
      })
      .where(eq(contentPacks.id, contentPack.id))
      .returning();

    return updatedPack;
  }

  const [updatedPack] = await db
    .update(contentPacks)
    .set({
      status: recoverableStatus,
      failureReason: null,
      updatedAt: new Date(),
    })
    .where(eq(contentPacks.id, contentPack.id))
    .returning();

  return updatedPack;
}

async function enqueueShortFormCandidateProcessing(params: {
  sourceAsset: {
    assetType: string;
    mimeType: string | null;
  };
  candidates: {
    id: number;
    userId: number;
    contentPackId: number;
    sourceAssetId: number;
    generationRunId: string;
  }[];
  editConfigs: {
    clipCandidateId: number;
    contentPackId: number;
    sourceAssetId: number;
    userId: number;
    generationRunId: string;
    aspectRatio: string;
    layout: string;
    captionsEnabled: boolean;
    captionFontAssetId: number | null;
    configHash: string;
  }[];
}) {
  const sourceIsUploadedVideo = isUploadedVideoSource(params.sourceAsset);

  if (sourceIsUploadedVideo) {
    const firstCandidate = params.candidates[0];

    if (firstCandidate) {
      const enqueueResult = await enqueueDetectVideoFacecamJob(
        firstCandidate.sourceAssetId,
        firstCandidate.userId,
        firstCandidate.contentPackId,
        firstCandidate.generationRunId
      );

      if (enqueueResult.status === 'reused_completed') {
        const existingSegments = await getFacecamSegmentsForVideo(
          firstCandidate.sourceAssetId,
          firstCandidate.userId
        );
        const status =
          existingSegments.length > 0
            ? FacecamDetectionStatus.READY
            : enqueueResult.job.status === JobStatus.FAILED ||
                enqueueResult.job.status === JobStatus.CANCELLED
              ? FacecamDetectionStatus.FAILED
            : FacecamDetectionStatus.NOT_FOUND;

        for (const candidate of params.candidates) {
          const editConfig = await applyFacecamResultToClipEditConfig({
            clipCandidateId: candidate.id,
            userId: candidate.userId,
            generationRunId: candidate.generationRunId,
            status,
          });
          await enqueueFormatRenderedClipShortFormJob(
            candidate.id,
            candidate.contentPackId,
            candidate.sourceAssetId,
            candidate.userId,
            candidate.generationRunId,
            getRenderedClipVariantForEditConfig(editConfig),
            editConfig.layout as RenderedClipLayout,
            editConfig.captionsEnabled,
            editConfig.captionFontAssetId ?? undefined,
            editConfig.configHash,
            undefined,
            true
          );
        }
      } else {
        await db
          .update(clipCandidates)
          .set({
            facecamDetectionStatus: FacecamDetectionStatus.PENDING,
            facecamDetectionFailureReason: null,
            facecamDetectionDebugReason: null,
            facecamDetectedAt: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(clipCandidates.contentPackId, firstCandidate.contentPackId),
              eq(clipCandidates.sourceAssetId, firstCandidate.sourceAssetId),
              eq(clipCandidates.userId, firstCandidate.userId)
            )
          );
      }
    }
    return;
  }

  if (params.sourceAsset.assetType !== SourceAssetType.UPLOADED_FILE) {
    return;
  }

  for (const config of params.editConfigs) {
    await enqueueFormatRenderedClipShortFormJob(
      config.clipCandidateId,
      config.contentPackId,
      config.sourceAssetId,
      config.userId,
      config.generationRunId,
      getRenderedClipVariantForEditConfig(config),
      config.layout as RenderedClipLayout,
      config.captionsEnabled,
      config.captionFontAssetId ?? undefined,
      config.configHash
    );
  }
}

export async function reconcileShortFormContentPackStatus(
  params: ReconcileShortFormContentPackStatusParams
) {
  const contentPack = await getShortFormPackWithArtifacts(params.contentPackId);

  if (!contentPack || contentPack.kind !== ContentPackKind.SHORT_FORM_CLIPS) {
    return null;
  }

  if (
    contentPack.sourceAssetId !== params.sourceAssetId ||
    contentPack.generationRunId !== params.generationRunId
  ) {
    return contentPack;
  }

  const currentCandidates = getCurrentGenerationClipCandidates(contentPack);

  if (currentCandidates.length === 0) {
    return contentPack;
  }

  if (contentPack.sourceAsset.assetType !== SourceAssetType.UPLOADED_FILE) {
    const updatedPack = await updateShortFormPackStatusIfChanged(
      contentPack,
      ContentPackStatus.READY,
      null
    );

    await createShortFormPackReadyNotification(updatedPack.id);
    return updatedPack;
  }

  const existingFacecamSegments = await getFacecamSegmentsForVideo(
    contentPack.sourceAssetId,
    contentPack.userId
  );
  const candidatesNeedingFacecamReconciliation = currentCandidates.filter(
    (candidate) =>
      ACTIVE_FACECAM_DETECTION_STATUSES.has(candidate.facecamDetectionStatus)
  );

  if (
    existingFacecamSegments.length > 0 &&
    candidatesNeedingFacecamReconciliation.length > 0
  ) {
    console.warn('short_form_pack.facecam_reconcile_repair', {
      contentPackId: contentPack.id,
      sourceAssetId: contentPack.sourceAssetId,
      generationRunId: contentPack.generationRunId,
      candidateCount: candidatesNeedingFacecamReconciliation.length,
      facecamSegmentCount: existingFacecamSegments.length,
    });

    for (const candidate of candidatesNeedingFacecamReconciliation) {
      const editConfig = await applyFacecamResultToClipEditConfig({
        clipCandidateId: candidate.id,
        userId: contentPack.userId,
        generationRunId: candidate.generationRunId,
        status: FacecamDetectionStatus.READY,
      });

      await enqueueFormatRenderedClipShortFormJob(
        candidate.id,
        candidate.contentPackId,
        candidate.sourceAssetId,
        contentPack.userId,
        candidate.generationRunId,
        getRenderedClipVariantForEditConfig(editConfig),
        editConfig.layout as RenderedClipLayout,
        editConfig.captionsEnabled,
        editConfig.captionFontAssetId ?? undefined,
        editConfig.configHash,
        undefined,
        true,
        'facecam_reconcile_repair'
      );
    }

    const updatedPack = await updateShortFormPackStatusIfChanged(
      contentPack,
      ContentPackStatus.GENERATING,
      null
    );

    return updatedPack;
  }

  const hasActiveProcessing =
    await hasActiveShortFormCandidateProcessing(contentPack);
  const renderResults = currentCandidates.map((candidate) => {
    const editConfig = candidate.editConfig;

    return editConfig
      ? candidate.renderedClips.find(
          (clip) =>
            clip.variant === getRenderedClipVariantForEditConfig(editConfig) &&
            clip.layout === editConfig.layout &&
            clip.editConfigHash === editConfig.configHash
        )
      : undefined;
  });
  const hasActiveRender = renderResults.some((clip) =>
    clip
      ? [RenderedClipStatus.PENDING, RenderedClipStatus.RENDERING].includes(
          clip.status as RenderedClipStatus
        )
      : true
  );

  if (hasActiveProcessing || hasActiveRender) {
    const updatedPack = await updateShortFormPackStatusIfChanged(
      contentPack,
      ContentPackStatus.GENERATING,
      null
    );

    return updatedPack;
  }

  const readyCount = renderResults.filter(
    (clip) => clip?.status === RenderedClipStatus.READY
  ).length;
  const nextStatus =
    readyCount === currentCandidates.length
      ? ContentPackStatus.READY
      : readyCount > 0
        ? ContentPackStatus.PARTIALLY_READY
        : ContentPackStatus.FAILED;

  const updatedPack = await updateShortFormPackStatusIfChanged(
    contentPack,
    nextStatus,
    nextStatus === ContentPackStatus.FAILED
      ? 'Clip rendering completed without a usable rendered clip.'
      : null
  );

  if (
    nextStatus === ContentPackStatus.READY ||
    nextStatus === ContentPackStatus.PARTIALLY_READY
  ) {
    await createShortFormPackReadyNotification(updatedPack.id);
  }

  return updatedPack;
}

export async function generateShortFormPack(
  contentPackId: number,
  expectedGenerationRunId?: string
) {
  const contentPack = await db.query.contentPacks.findFirst({
    where: eq(contentPacks.id, contentPackId),
    with: {
      sourceAsset: true,
      transcript: {
        with: {
          segments: true,
        },
      },
      clipCandidates: {
        with: {
          editConfig: true,
        },
      },
    },
  });

  if (!contentPack) {
    throw new Error('Content pack not found.');
  }

  if (
    expectedGenerationRunId &&
    contentPack.generationRunId !== expectedGenerationRunId
  ) {
    return contentPack;
  }

  if (contentPack.kind !== ContentPackKind.SHORT_FORM_CLIPS) {
    throw new Error('Only short-form clip packs can be generated by this workflow.');
  }

  if (!contentPack.transcript || contentPack.transcript.status !== 'ready') {
    throw new Error('A ready transcript is required before generating short-form clips.');
  }

  if (
    ![SourceAssetType.UPLOADED_FILE, SourceAssetType.YOUTUBE_URL].includes(
      contentPack.sourceAsset.assetType as SourceAssetType
    )
  ) {
    throw new Error('This source asset type does not support short-form clips.');
  }

  if (contentPack.transcript.segments.length === 0) {
    throw new Error('This transcript does not include timestamps for clip generation.');
  }

  await markContentPackGenerating(
    contentPack.id,
    contentPack.transcript.id,
    contentPack.generationRunId
  );

  const hasStaleCandidates = contentPack.clipCandidates.some(
    (candidate) => candidate.generationRunId !== contentPack.generationRunId
  );

  if (hasStaleCandidates) {
    await db.transaction(async (tx) => {
      await deleteExistingShortFormPackArtifacts(
        tx,
        contentPack.id,
        contentPack.generationRunId
      );
    });
  }

  if (contentPack.clipCandidates.length > 0 && !hasStaleCandidates) {
    await ensureDefaultClipEditConfigs(contentPack.clipCandidates, db);
    const candidates = await db.query.clipCandidates.findMany({
      where: eq(clipCandidates.contentPackId, contentPack.id),
      columns: {
        id: true,
        userId: true,
        contentPackId: true,
        sourceAssetId: true,
        generationRunId: true,
      },
      with: {
        editConfig: true,
      },
    });
    const editConfigs = candidates
      .map((candidate) => candidate.editConfig)
      .filter((config): config is NonNullable<typeof config> => Boolean(config));

    await enqueueShortFormCandidateProcessing({
      sourceAsset: contentPack.sourceAsset,
      candidates,
      editConfigs,
    });

    return contentPack;
  }

  const clipLength = parseShortFormClipLengthFromInstructions(
    contentPack.instructions
  );
  const clipWindowConfig = getShortFormClipWindowConfig(clipLength);
  const autoHookEnabled = parseShortFormAutoHookEnabledFromInstructions(
    contentPack.instructions
  );
  const windows = buildCandidateWindows(
    contentPack.transcript.segments,
    clipWindowConfig
  );
  const targetCandidateRange = getTargetCandidateRange(
    getTranscriptDurationMs(contentPack.transcript.segments)
  );

  if (windows.length === 0) {
    throw new Error('No usable short-form windows were found in this transcript.');
  }

  const rankedCandidates = await rankShortFormClipWindows({
    sourceTitle: contentPack.sourceAsset.title,
    generationInstructions: contentPack.instructions,
    clipLength,
    targetClipDurationMs: {
      min: clipWindowConfig.minDurationMs,
      max: clipWindowConfig.maxDurationMs
    },
    autoHookEnabled,
    windows,
    targetCandidateRange,
  });
  const windowsById = new Map(windows.map((window) => [window.id, window]));
  const uniqueCandidates = dedupeRankedCandidates(
    rankedCandidates,
    windowsById,
    targetCandidateRange.max
  );

  if (uniqueCandidates.length === 0) {
    throw new Error('No usable short-form clip candidates were returned.');
  }

  const { updatedPack, insertedCandidates, editConfigs } = await db.transaction(async (tx) => {
    const [updatedPack] = await tx
      .update(contentPacks)
      .set({
        status: ContentPackStatus.GENERATING,
        transcriptId: contentPack.transcript!.id,
        failureReason: null,
        updatedAt: new Date(),
      })
      .where(eq(contentPacks.id, contentPack.id))
      .returning();

    const insertedCandidates = await tx.insert(clipCandidates).values(
      uniqueCandidates.map((candidate, index) => {
        const window = windowsById.get(candidate.windowId)!;
        const timing = validateClipTiming(window, 'Clip candidate');

        return {
          userId: contentPack.userId,
          contentPackId: contentPack.id,
          sourceAssetId: contentPack.sourceAssetId,
          transcriptId: contentPack.transcript!.id,
          generationRunId: contentPack.generationRunId,
          rank: index + 1,
          startTimeMs: timing.startTimeMs,
          endTimeMs: timing.endTimeMs,
          durationMs: timing.durationMs,
          hook: candidate.hook,
          title: candidate.title,
          captionCopy: candidate.captionCopy,
          summary: candidate.summary,
          transcriptExcerpt: window.transcriptExcerpt,
          whyItWorks: candidate.whyItWorks,
          platformFit: candidate.platformFit,
          confidence: candidate.confidence,
        };
      })
    ).returning({
      id: clipCandidates.id,
      userId: clipCandidates.userId,
      contentPackId: clipCandidates.contentPackId,
      sourceAssetId: clipCandidates.sourceAssetId,
      generationRunId: clipCandidates.generationRunId,
      rank: clipCandidates.rank,
      startTimeMs: clipCandidates.startTimeMs,
      endTimeMs: clipCandidates.endTimeMs,
      durationMs: clipCandidates.durationMs,
    });

    const editConfigs = await ensureDefaultClipEditConfigs(insertedCandidates, tx);

    return { updatedPack, insertedCandidates, editConfigs };
  });

  for (const candidate of insertedCandidates) {
    logClipCandidateCreated(candidate);
  }

  for (const config of editConfigs) {
    logClipEditConfigCreated(config);
  }

  await enqueueShortFormCandidateProcessing({
    sourceAsset: contentPack.sourceAsset,
    candidates: insertedCandidates,
    editConfigs,
  });

  const contentPackage = parseContentPackageFromInstructions(contentPack.instructions);

  await db
    .delete(generatedAssets)
    .where(
      and(
        eq(generatedAssets.contentPackId, contentPack.id),
        inArray(generatedAssets.assetType, [...PACKAGE_GENERATED_ASSET_TYPES])
      )
    );

  if (!packageCreatesGeneratedAssets(contentPackage)) {
    return updatedPack;
  }

  const packageAssets = await generatePackageAssets({
    sourceTitle: contentPack.sourceAsset.title,
    contentPackage,
    candidates: uniqueCandidates.map((candidate, index) => {
      const window = windowsById.get(candidate.windowId)!;
      validateClipTiming(window, 'Generated package clip window');

      return {
        rank: index + 1,
        hook: candidate.hook,
        title: candidate.title,
        captionCopy: candidate.captionCopy,
        summary: candidate.summary,
        transcriptExcerpt: window.transcriptExcerpt,
        whyItWorks: candidate.whyItWorks,
        platformFit: candidate.platformFit
      };
    })
  });

  await db.insert(generatedAssets).values(
    packageAssets.map((asset) => ({
      userId: contentPack.userId,
      contentPackId: contentPack.id,
      assetType: asset.assetType,
      title: asset.title,
      content: asset.content
    }))
  );

  return updatedPack;
}

async function deleteExistingShortFormPackArtifacts(
  tx: DbTransaction,
  contentPackId: number,
  currentGenerationRunId: string
) {
  const existingCandidates = await tx.query.clipCandidates.findMany({
    where: and(
      eq(clipCandidates.contentPackId, contentPackId),
      sql<boolean>`${clipCandidates.generationRunId} <> ${currentGenerationRunId}`
    ),
    columns: {
      id: true,
    },
  });

  const candidateIds = existingCandidates.map((candidate) => candidate.id);

  await cancelShortFormPipelineJobsForContentPack(
    contentPackId,
    StaleJobReason.GENERATION_RUN_STALE,
    currentGenerationRunId,
    'neq',
    tx
  );

  if (candidateIds.length > 0) {
    const existingRenderedClips = await tx.query.renderedClips.findMany({
      where: inArray(renderedClips.clipCandidateId, candidateIds),
      columns: {
        id: true,
      },
    });
    const renderedClipIds = existingRenderedClips.map((clip) => clip.id);

    if (renderedClipIds.length > 0) {
      await tx
        .delete(clipPublications)
        .where(inArray(clipPublications.renderedClipId, renderedClipIds));

      await tx
        .delete(renderedClips)
        .where(inArray(renderedClips.id, renderedClipIds));
    }

    await tx
      .delete(clipEditConfigs)
      .where(inArray(clipEditConfigs.clipCandidateId, candidateIds));

    await tx
      .delete(clipCandidateFacecamDetections)
      .where(inArray(clipCandidateFacecamDetections.clipCandidateId, candidateIds));

    await tx
      .delete(clipCandidates)
      .where(inArray(clipCandidates.id, candidateIds));
  }
}
