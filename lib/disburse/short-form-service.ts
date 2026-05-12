import 'server-only';

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import {
  clipCandidateFacecamDetections,
  clipCandidates,
  clipEditConfigs,
  clipPublications,
  contentPacks,
  ContentPackKind,
  ContentPackStatus,
  generatedAssets,
  RenderedClipLayout,
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
import {
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
  parseShortFormFacecamDetectionEnabledFromInstructions
} from '@/lib/disburse/short-form-setup-config';
import {
  enqueueDetectClipFacecamJob,
  enqueueFormatRenderedClipShortFormJob,
} from '@/lib/disburse/job-service';
import {
  createShortFormPackFailedNotification,
  createShortFormPackReadyNotification,
} from '@/lib/disburse/notification-service';

const MAX_WINDOWS = 72;
const SHORT_SOURCE_DURATION_MS = 5 * 60 * 1000;
const LONG_SOURCE_DURATION_MS = 20 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_CANDIDATES = 15;
const LONG_SOURCE_MAX_OUTPUT_CANDIDATES = 20;

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
      startTimeMs: firstSegment.startTimeMs,
      endTimeMs,
      durationMs,
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
  transcriptId: number;
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
        transcriptId: params.transcriptId,
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
      transcriptId: params.transcriptId,
      kind: ContentPackKind.SHORT_FORM_CLIPS,
      name: buildShortFormPackName(sourceAsset.title),
      instructions:
        params.instructions ||
        'AI-ranked short-form clip candidates for distribution across Shorts, TikTok, and Reels.',
      status: ContentPackStatus.PENDING,
    })
    .returning();

  return contentPack;
}

async function markContentPackGenerating(contentPackId: number, transcriptId: number) {
  await db
    .update(contentPacks)
    .set({
      status: ContentPackStatus.GENERATING,
      transcriptId,
      failureReason: null,
      updatedAt: new Date(),
    })
    .where(eq(contentPacks.id, contentPackId));
}

export async function markContentPackFailed(contentPackId: number, reason: string) {
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

export async function generateShortFormPack(contentPackId: number) {
  const contentPack = await db.query.contentPacks.findFirst({
    where: eq(contentPacks.id, contentPackId),
    with: {
      sourceAsset: true,
      transcript: {
        with: {
          segments: true,
        },
      },
      clipCandidates: true,
    },
  });

  if (!contentPack) {
    throw new Error('Content pack not found.');
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

  await markContentPackGenerating(contentPack.id, contentPack.transcript.id);

  const clipLength = parseShortFormClipLengthFromInstructions(
    contentPack.instructions
  );
  const clipWindowConfig = getShortFormClipWindowConfig(clipLength);
  const autoHookEnabled = parseShortFormAutoHookEnabledFromInstructions(
    contentPack.instructions
  );
  const facecamDetectionEnabled =
    parseShortFormFacecamDetectionEnabledFromInstructions(
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
    await deleteExistingShortFormPackArtifacts(tx, contentPack.id);

    const [updatedPack] = await tx
      .update(contentPacks)
      .set({
        status: ContentPackStatus.READY,
        transcriptId: contentPack.transcript!.id,
        failureReason: null,
        updatedAt: new Date(),
      })
      .where(eq(contentPacks.id, contentPack.id))
      .returning();

    const insertedCandidates = await tx.insert(clipCandidates).values(
      uniqueCandidates.map((candidate, index) => {
        const window = windowsById.get(candidate.windowId)!;

        return {
          userId: contentPack.userId,
          contentPackId: contentPack.id,
          sourceAssetId: contentPack.sourceAssetId,
          transcriptId: contentPack.transcript!.id,
          rank: index + 1,
          startTimeMs: window.startTimeMs,
          endTimeMs: window.endTimeMs,
          durationMs: window.durationMs,
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
    });

    const editConfigs = await ensureDefaultClipEditConfigs(insertedCandidates, tx);

    return { updatedPack, insertedCandidates, editConfigs };
  });

  if (contentPack.sourceAsset.assetType === SourceAssetType.UPLOADED_FILE) {
    if (facecamDetectionEnabled) {
      for (const candidate of insertedCandidates) {
        await enqueueDetectClipFacecamJob(
          candidate.id,
          candidate.contentPackId,
          candidate.sourceAssetId,
          candidate.userId
        );
      }
    } else {
      for (const config of editConfigs) {
        await enqueueFormatRenderedClipShortFormJob(
          config.clipCandidateId,
          config.contentPackId,
          config.sourceAssetId,
          config.userId,
          getRenderedClipVariantForEditConfig(config),
          config.layout as RenderedClipLayout,
          config.captionsEnabled,
          config.captionFontAssetId ?? undefined,
          config.configHash
        );
      }
    }
  }

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
    await createShortFormPackReadyNotification(updatedPack.id);
    return updatedPack;
  }

  const packageAssets = await generatePackageAssets({
    sourceTitle: contentPack.sourceAsset.title,
    contentPackage,
    candidates: uniqueCandidates.map((candidate, index) => {
      const window = windowsById.get(candidate.windowId)!;

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

  await createShortFormPackReadyNotification(updatedPack.id);
  return updatedPack;
}

async function deleteExistingShortFormPackArtifacts(
  tx: DbTransaction,
  contentPackId: number
) {
  const existingCandidates = await tx.query.clipCandidates.findMany({
    where: eq(clipCandidates.contentPackId, contentPackId),
    columns: {
      id: true,
    },
  });

  const candidateIds = existingCandidates.map((candidate) => candidate.id);

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
