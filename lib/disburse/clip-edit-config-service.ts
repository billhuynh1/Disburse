import 'server-only';

import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import {
  clipCandidateFacecamDetections,
  clipCandidates,
  clipEditConfigs,
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
}): NewClipEditConfig {
  const values = {
    userId: params.userId,
    contentPackId: params.contentPackId,
    sourceAssetId: params.sourceAssetId,
    clipCandidateId: params.clipCandidateId,
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
    },
    executor
  );
}

export async function applyFacecamResultToClipEditConfig(params: {
  clipCandidateId: number;
  userId: number;
  status: FacecamDetectionStatus;
}) {
  const config = await getOrCreateClipEditConfig(
    params.clipCandidateId,
    params.userId
  );
  const facecamDetection =
    params.status === FacecamDetectionStatus.READY
      ? await db.query.clipCandidateFacecamDetections.findFirst({
          where: and(
            eq(
              clipCandidateFacecamDetections.clipCandidateId,
              params.clipCandidateId
            ),
            eq(clipCandidateFacecamDetections.userId, params.userId)
          ),
          orderBy: (detections, { asc }) => [asc(detections.rank)],
        })
      : null;
  const nextValues = {
    aspectRatio: config.aspectRatio,
    layout: facecamDetection ? DEFAULT_FACECAM_LAYOUT : DEFAULT_CLIP_LAYOUT,
    layoutRatio: facecamDetection ? DEFAULT_FACECAM_LAYOUT_RATIO : null,
    captionsEnabled: config.captionsEnabled,
    captionStyle: config.captionStyle,
    captionFontAssetId: config.captionFontAssetId,
    facecamDetectionId: facecamDetection?.id || null,
    facecamDetected: Boolean(facecamDetection),
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
