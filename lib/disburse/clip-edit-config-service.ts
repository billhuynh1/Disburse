import 'server-only';

import { and, asc, desc, eq, gte, lte } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import {
  clipCandidates,
  clipEditConfigs,
  facecamSegments,
  FacecamDetectionStatus,
  RenderedClipLayout,
  type ClipEditConfig,
  type NewClipEditConfig,
} from '@/lib/db/schema';
export {
  buildClipEditConfigHash,
  DEFAULT_CLIP_ASPECT_RATIO,
  DEFAULT_CLIP_AUTO_EDIT_PRESET,
  DEFAULT_CLIP_CAPTION_STYLE,
  DEFAULT_CLIP_LAYOUT,
  DEFAULT_FACECAM_LAYOUT,
  DEFAULT_FACECAM_LAYOUT_RATIO,
  getRenderedClipVariantForEditConfig,
  hasClipEditConfigSettingsChanged,
  type ClipEditAspectRatio,
} from '@/lib/disburse/clip-edit-config-utils';
import {
  buildClipEditConfigHash,
  DEFAULT_CLIP_ASPECT_RATIO,
  DEFAULT_CLIP_AUTO_EDIT_PRESET,
  DEFAULT_CLIP_CAPTION_STYLE,
  DEFAULT_CLIP_LAYOUT,
  DEFAULT_FACECAM_LAYOUT,
  DEFAULT_FACECAM_LAYOUT_RATIO,
  getRenderedClipVariantForEditConfig,
  hasClipEditConfigSettingsChanged,
  type ClipEditAspectRatio,
} from '@/lib/disburse/clip-edit-config-utils';

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = typeof db | DbTransaction;

function buildDefaultConfigValues(params: {
  userId: number;
  contentPackId: number;
  sourceAssetId: number;
  clipCandidateId: number;
  generationRunId: string;
}): NewClipEditConfig {
  const values = {
    userId: params.userId,
    contentPackId: params.contentPackId,
    sourceAssetId: params.sourceAssetId,
    clipCandidateId: params.clipCandidateId,
    generationRunId: params.generationRunId,
    aspectRatio: DEFAULT_CLIP_ASPECT_RATIO,
    layout: DEFAULT_CLIP_LAYOUT,
    layoutRatio: null,
    captionsEnabled: true,
    captionStyle: DEFAULT_CLIP_CAPTION_STYLE,
    captionFontAssetId: null,
    facecamDetectionId: null,
    facecamDetected: false,
    autoEditPreset: DEFAULT_CLIP_AUTO_EDIT_PRESET,
    autoEditAppliedAt: new Date(),
    configVersion: 1,
  };

  return {
    ...values,
    configHash: buildClipEditConfigHash(values),
  };
}

export async function ensureDefaultClipEditConfig(
  params: {
    userId: number;
    contentPackId: number;
    sourceAssetId: number;
    clipCandidateId: number;
    generationRunId: string;
  },
  executor: DbLike = db
) {
  const existingConfig = await executor.query.clipEditConfigs.findFirst({
    where: and(
      eq(clipEditConfigs.clipCandidateId, params.clipCandidateId),
      eq(clipEditConfigs.userId, params.userId)
    ),
  });

  if (existingConfig) {
    return existingConfig;
  }

  const [config] = await executor
    .insert(clipEditConfigs)
    .values(buildDefaultConfigValues(params))
    .returning();

  return config;
}

export async function ensureDefaultClipEditConfigs(
  candidates: {
    id: number;
    userId: number;
    contentPackId: number;
    sourceAssetId: number;
    generationRunId: string;
  }[],
  executor: DbLike = db
) {
  if (candidates.length === 0) {
    return [];
  }

  const values = candidates.map((candidate) =>
    buildDefaultConfigValues({
      userId: candidate.userId,
      contentPackId: candidate.contentPackId,
      sourceAssetId: candidate.sourceAssetId,
      clipCandidateId: candidate.id,
      generationRunId: candidate.generationRunId,
    })
  );

  return await executor
    .insert(clipEditConfigs)
    .values(values)
    .onConflictDoNothing()
    .returning();
}

async function getClipCandidateForConfig(
  clipCandidateId: number,
  executor: DbLike = db
) {
  return await executor.query.clipCandidates.findFirst({
    where: eq(clipCandidates.id, clipCandidateId),
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
}

export async function getOrCreateClipEditConfig(
  clipCandidateId: number,
  userId: number,
  executor: DbLike = db
) {
  const candidate = await getClipCandidateForConfig(clipCandidateId, executor);

  if (!candidate || candidate.userId !== userId) {
    throw new Error('Clip candidate not found.');
  }

  if (candidate.editConfig) {
    return candidate.editConfig;
  }

  return await ensureDefaultClipEditConfig(
    {
      userId: candidate.userId,
      contentPackId: candidate.contentPackId,
      sourceAssetId: candidate.sourceAssetId,
      clipCandidateId: candidate.id,
      generationRunId: candidate.generationRunId,
    },
    executor
  );
}

export async function applyFacecamResultToClipEditConfig(params: {
  clipCandidateId: number;
  userId: number;
  generationRunId: string;
  status: FacecamDetectionStatus;
  failureReason?: string | null;
  debugReason?: string | null;
}) {
  const config = await getOrCreateClipEditConfig(
    params.clipCandidateId,
    params.userId
  );
  const candidate =
    params.status === FacecamDetectionStatus.READY
      ? await db.query.clipCandidates.findFirst({
          where: and(
            eq(clipCandidates.id, params.clipCandidateId),
            eq(clipCandidates.userId, params.userId)
          ),
          columns: {
            sourceAssetId: true,
            startTimeMs: true,
            endTimeMs: true,
          },
        })
      : null;
  const facecamSegment = candidate
    ? (
        await db
          .select({ id: facecamSegments.id })
          .from(facecamSegments)
          .where(
            and(
              eq(facecamSegments.videoId, candidate.sourceAssetId),
              eq(facecamSegments.userId, params.userId),
              lte(facecamSegments.startTimeMs, candidate.endTimeMs),
              gte(facecamSegments.endTimeMs, candidate.startTimeMs)
            )
          )
          .orderBy(desc(facecamSegments.confidence), asc(facecamSegments.rank))
          .limit(1)
      )[0] || null
    : null;
  const nextValues = {
    aspectRatio: config.aspectRatio,
    layout: facecamSegment ? DEFAULT_FACECAM_LAYOUT : DEFAULT_CLIP_LAYOUT,
    layoutRatio: facecamSegment ? DEFAULT_FACECAM_LAYOUT_RATIO : null,
    captionsEnabled: config.captionsEnabled,
    captionStyle: config.captionStyle,
    captionFontAssetId: config.captionFontAssetId,
    facecamDetectionId: null,
    facecamDetected: Boolean(facecamSegment),
    autoEditPreset: config.autoEditPreset,
  };
  const nextConfigHash = buildClipEditConfigHash(nextValues);
  const nextFacecamStatus =
    params.status === FacecamDetectionStatus.READY && facecamSegment
      ? FacecamDetectionStatus.READY
      : params.status === FacecamDetectionStatus.READY
        ? FacecamDetectionStatus.NOT_FOUND
        : params.status;
  const now = new Date();
  const failureReason =
    nextFacecamStatus === FacecamDetectionStatus.READY ||
    nextFacecamStatus === FacecamDetectionStatus.NOT_FOUND
      ? null
      : params.failureReason?.trim().slice(0, 5000) || null;
  const debugReason =
    nextFacecamStatus === FacecamDetectionStatus.READY ||
    nextFacecamStatus === FacecamDetectionStatus.NOT_FOUND
      ? null
      : params.debugReason?.trim().slice(0, 5000) || null;

  if (
    config.generationRunId === params.generationRunId &&
    !hasClipEditConfigSettingsChanged(config, nextValues)
  ) {
    await db
      .update(clipCandidates)
      .set({
        facecamDetectionStatus: nextFacecamStatus,
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

    return config;
  }

  const [updatedConfig] = await db.transaction(async (tx) => {
    await tx
      .update(clipCandidates)
      .set({
        facecamDetectionStatus: nextFacecamStatus,
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

    return await tx
      .update(clipEditConfigs)
      .set({
        ...nextValues,
        generationRunId: params.generationRunId,
        configVersion: config.configVersion + 1,
        configHash: nextConfigHash,
        updatedAt: now,
      })
      .where(eq(clipEditConfigs.id, config.id))
      .returning();
  });

  return updatedConfig;
}

export async function updateClipEditConfigFromEditor(params: {
  clipCandidateId: number;
  userId: number;
  aspectRatio: ClipEditAspectRatio;
  layout: RenderedClipLayout;
  captionsEnabled: boolean;
  captionFontAssetId?: number;
}) {
  const config = await getOrCreateClipEditConfig(
    params.clipCandidateId,
    params.userId
  );
  const isFacecamLayout =
    params.layout === RenderedClipLayout.FACECAM_TOP_50 ||
    params.layout === RenderedClipLayout.FACECAM_TOP_40 ||
    params.layout === RenderedClipLayout.FACECAM_TOP_30;
  const layoutRatio =
    params.layout === RenderedClipLayout.FACECAM_TOP_50
      ? '50_50'
      : params.layout === RenderedClipLayout.FACECAM_TOP_40
        ? '40_60'
        : params.layout === RenderedClipLayout.FACECAM_TOP_30
          ? '30_70'
          : null;
  const nextValues = {
    aspectRatio: params.aspectRatio,
    layout: params.layout,
    layoutRatio,
    captionsEnabled: params.captionsEnabled,
    captionStyle: config.captionStyle,
    captionFontAssetId: params.captionFontAssetId || null,
    facecamDetectionId: isFacecamLayout ? config.facecamDetectionId : null,
    facecamDetected: isFacecamLayout ? config.facecamDetected : false,
    autoEditPreset: config.autoEditPreset,
  };
  const nextConfigHash = buildClipEditConfigHash(nextValues);

  if (!hasClipEditConfigSettingsChanged(config, nextValues)) {
    return config;
  }

  const [updatedConfig] = await db
    .update(clipEditConfigs)
    .set({
      ...nextValues,
      configVersion: config.configVersion + 1,
      configHash: nextConfigHash,
      updatedAt: new Date(),
    })
    .where(eq(clipEditConfigs.id, config.id))
    .returning();

  return updatedConfig;
}
