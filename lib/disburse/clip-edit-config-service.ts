import 'server-only';

import { and, asc, desc, eq, gte, lte } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import {
  brandTemplates,
  clipCandidateFacecamDetectionRuns,
  clipCandidateFacecamDetections,
  clipCandidates,
  clipEditConfigs,
  facecamSegments,
  FacecamDetectionStatus,
  RenderedClipLayout,
  type BrandTemplate,
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
  type SourceCropPreset,
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
  type SourceCropPreset,
} from '@/lib/disburse/clip-edit-config-utils';

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = typeof db | DbTransaction;

function buildDefaultConfigValues(params: {
  userId: number;
  contentPackId: number;
  sourceAssetId: number;
  clipCandidateId: number;
  generationRunId: string;
  defaultBrandTemplate?: BrandTemplate | null;
}): NewClipEditConfig {
  const template = params.defaultBrandTemplate;
  const templateLayout = template?.defaultLayout as RenderedClipLayout | undefined;
  const templateLayoutRatio =
    templateLayout === RenderedClipLayout.FACECAM_TOP_50
      ? '50_50'
      : templateLayout === RenderedClipLayout.FACECAM_TOP_40
        ? '40_60'
        : templateLayout === RenderedClipLayout.FACECAM_TOP_30
          ? '30_70'
          : null;
  const values = {
    userId: params.userId,
    contentPackId: params.contentPackId,
    sourceAssetId: params.sourceAssetId,
    clipCandidateId: params.clipCandidateId,
    generationRunId: params.generationRunId,
    aspectRatio: template
      ? (template.aspectRatio as ClipEditAspectRatio)
      : DEFAULT_CLIP_ASPECT_RATIO,
    layout: templateLayout || DEFAULT_CLIP_LAYOUT,
    layoutRatio: templateLayoutRatio,
    captionsEnabled: true,
    captionStyle: template?.captionStyle || DEFAULT_CLIP_CAPTION_STYLE,
    captionFontAssetId: template?.captionFontAssetId || null,
    captionFontFamily: template?.captionFontFamily || null,
    captionFontColor: template?.captionFontColor || '#ffffff',
    captionHighlightColor: template?.captionHighlightColor || '#facc15',
    captionPosition: template?.captionPosition || 'bottom',
    captionAnimation: template?.captionAnimation || 'none',
    brandTemplateId: template?.id || null,
    overlayLogoAssetId: template?.logoAssetId || null,
    ctaUrl: template?.ctaUrl || null,
    introVideoAssetId: template?.introVideoAssetId || null,
    outroVideoAssetId: template?.outroVideoAssetId || null,
    cropSettings: template?.cropSettings || {},
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

async function getDefaultBrandTemplateForUser(
  userId: number,
  executor: DbLike = db
) {
  return await executor.query.brandTemplates.findFirst({
    where: and(
      eq(brandTemplates.userId, userId),
      eq(brandTemplates.isDefault, true)
    ),
  });
}

async function resolveBrandTemplateForUser(
  userId: number,
  brandTemplateId: number | undefined,
  executor: DbLike = db
) {
  if (brandTemplateId) {
    const selectedTemplate = await executor.query.brandTemplates.findFirst({
      where: and(
        eq(brandTemplates.id, brandTemplateId),
        eq(brandTemplates.userId, userId)
      ),
    });

    if (selectedTemplate) {
      return selectedTemplate;
    }
  }

  return await getDefaultBrandTemplateForUser(userId, executor);
}

export async function ensureDefaultClipEditConfig(
  params: {
    userId: number;
    contentPackId: number;
    sourceAssetId: number;
    clipCandidateId: number;
    generationRunId: string;
    brandTemplateId?: number;
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

  const defaultBrandTemplate = await resolveBrandTemplateForUser(
    params.userId,
    params.brandTemplateId,
    executor
  );
  const [config] = await executor
    .insert(clipEditConfigs)
    .values(buildDefaultConfigValues({ ...params, defaultBrandTemplate }))
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
  brandTemplateId?: number,
  executor: DbLike = db
) {
  if (candidates.length === 0) {
    return [];
  }

  const defaultTemplatesByUserId = new Map<number, BrandTemplate | null>();
  const values: NewClipEditConfig[] = [];

  for (const candidate of candidates) {
    if (!defaultTemplatesByUserId.has(candidate.userId)) {
      defaultTemplatesByUserId.set(
        candidate.userId,
        (await resolveBrandTemplateForUser(
          candidate.userId,
          brandTemplateId,
          executor
        )) || null
      );
    }

    values.push(
      buildDefaultConfigValues({
        userId: candidate.userId,
        contentPackId: candidate.contentPackId,
        sourceAssetId: candidate.sourceAssetId,
        clipCandidateId: candidate.id,
        generationRunId: candidate.generationRunId,
        defaultBrandTemplate: defaultTemplatesByUserId.get(candidate.userId),
      })
    );
  }

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
}, executor: DbLike = db) {
  const config = await getOrCreateClipEditConfig(
    params.clipCandidateId,
    params.userId,
    executor
  );
  const candidate =
    params.status === FacecamDetectionStatus.READY
      ? await executor.query.clipCandidates.findFirst({
          where: and(
            eq(clipCandidates.id, params.clipCandidateId),
            eq(clipCandidates.userId, params.userId)
          ),
          columns: {
            sourceAssetId: true,
            startTimeMs: true,
            endTimeMs: true,
            generationRunId: true,
          },
        })
      : null;
  const candidateDetection = candidate
    ? (
        await executor
          .select({ id: clipCandidateFacecamDetections.id })
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
              eq(clipCandidateFacecamDetections.clipCandidateId, params.clipCandidateId),
              eq(clipCandidateFacecamDetections.userId, params.userId),
              eq(clipCandidateFacecamDetections.generationRunId, candidate.generationRunId),
              eq(clipCandidateFacecamDetectionRuns.status, FacecamDetectionStatus.READY)
            )
          )
          .orderBy(
            desc(clipCandidateFacecamDetections.confidence),
            asc(clipCandidateFacecamDetections.rank)
          )
          .limit(1)
      )[0] || null
    : null;
  const facecamSegment = candidate
    ? (
        await executor
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
  const hasFacecamDetection = Boolean(candidateDetection || facecamSegment);
  const nextValues = {
    aspectRatio: config.aspectRatio,
    layout: hasFacecamDetection ? DEFAULT_FACECAM_LAYOUT : DEFAULT_CLIP_LAYOUT,
    layoutRatio: hasFacecamDetection ? DEFAULT_FACECAM_LAYOUT_RATIO : null,
    captionsEnabled: config.captionsEnabled,
    captionStyle: config.captionStyle,
    captionFontAssetId: config.captionFontAssetId,
    captionFontFamily: config.captionFontFamily,
    captionFontColor: config.captionFontColor,
    captionHighlightColor: config.captionHighlightColor,
    captionPosition: config.captionPosition,
    captionAnimation: config.captionAnimation,
    brandTemplateId: config.brandTemplateId,
    overlayLogoAssetId: config.overlayLogoAssetId,
    ctaUrl: config.ctaUrl,
    introVideoAssetId: config.introVideoAssetId,
    outroVideoAssetId: config.outroVideoAssetId,
    cropSettings: config.cropSettings,
    facecamDetectionId: candidateDetection?.id ?? null,
    facecamDetected: hasFacecamDetection,
    autoEditPreset: config.autoEditPreset,
  };
  const nextConfigHash = buildClipEditConfigHash(nextValues);
  const nextFacecamStatus =
    params.status === FacecamDetectionStatus.READY && hasFacecamDetection
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
    await executor
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

  const persist = async (tx: DbLike) => {
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
  };

  const [updatedConfig] = executor === db
    ? await db.transaction(async (tx) => await persist(tx))
    : await persist(executor);

  return updatedConfig;
}

export async function updateClipEditConfigFromEditor(params: {
  clipCandidateId: number;
  userId: number;
  aspectRatio: ClipEditAspectRatio;
  layout: RenderedClipLayout;
  captionsEnabled: boolean;
  captionStyle?: string;
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
    captionStyle: params.captionStyle || config.captionStyle,
    captionFontAssetId: params.captionFontAssetId || null,
    captionFontFamily: config.captionFontFamily,
    captionFontColor: config.captionFontColor,
    captionHighlightColor: config.captionHighlightColor,
    captionPosition: config.captionPosition,
    captionAnimation: config.captionAnimation,
    brandTemplateId: config.brandTemplateId,
    overlayLogoAssetId: config.overlayLogoAssetId,
    ctaUrl: config.ctaUrl,
    introVideoAssetId: config.introVideoAssetId,
    outroVideoAssetId: config.outroVideoAssetId,
    cropSettings: config.cropSettings,
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
