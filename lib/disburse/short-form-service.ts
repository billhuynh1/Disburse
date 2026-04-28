import 'server-only';

import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import {
  clipCandidates,
  contentPacks,
  ContentPackKind,
  ContentPackStatus,
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

const MIN_CLIP_DURATION_MS = 15_000;
const TARGET_CLIP_DURATION_MS = 35_000;
const MAX_CLIP_DURATION_MS = 65_000;
const MAX_WINDOWS = 72;
const MAX_EXCERPT_CHARS = 900;
const SHORT_SOURCE_DURATION_MS = 5 * 60 * 1000;
const LONG_SOURCE_DURATION_MS = 20 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_CANDIDATES = 15;
const LONG_SOURCE_MAX_OUTPUT_CANDIDATES = 20;

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

function buildCandidateWindows(segments: TranscriptSegment[]): ClipCandidateWindow[] {
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

      if (nextExcerpt.length > MAX_EXCERPT_CHARS) {
        break;
      }

      excerptParts = nextParts;
      endTimeMs = segment.endTimeMs;

      if (nextDurationMs >= TARGET_CLIP_DURATION_MS) {
        break;
      }

      if (nextDurationMs >= MAX_CLIP_DURATION_MS) {
        break;
      }
    }

    const transcriptExcerpt = excerptParts.join(' ').trim();
    const durationMs = endTimeMs - firstSegment.startTimeMs;

    if (
      transcriptExcerpt.length === 0 ||
      durationMs < MIN_CLIP_DURATION_MS ||
      durationMs > MAX_CLIP_DURATION_MS
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

  const windows = buildCandidateWindows(contentPack.transcript.segments);
  const targetCandidateRange = getTargetCandidateRange(
    getTranscriptDurationMs(contentPack.transcript.segments)
  );

  if (windows.length === 0) {
    throw new Error('No usable short-form windows were found in this transcript.');
  }

  const rankedCandidates = await rankShortFormClipWindows({
    sourceTitle: contentPack.sourceAsset.title,
    generationInstructions: contentPack.instructions,
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

  return await db.transaction(async (tx) => {
    await tx
      .delete(clipCandidates)
      .where(eq(clipCandidates.contentPackId, contentPack.id));

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

    await tx.insert(clipCandidates).values(
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
    );

    return updatedPack;
  });
}
