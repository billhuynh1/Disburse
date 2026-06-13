import 'server-only';

import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db/drizzle';
import {
  brandTemplates,
  clipRenderConfigs,
  clipEditConfigs,
  RenderedClipLayout,
  ReusableAssetKind,
  type BrandTemplate,
  type NewBrandTemplate,
  type NewClipRenderConfig,
  type User,
} from '@/lib/db/schema';
import {
  buildClipEditConfigHash,
  getOrCreateClipEditConfig,
  type ClipEditAspectRatio,
} from '@/lib/disburse/clip-edit-config-service';
import {
  brandTemplateInputSchema,
  normalizeCropSettings,
  normalizeEnabledAspectRatios,
  normalizeEnabledLayouts,
  type BrandTemplateInput,
} from '@/lib/disburse/brand-template-validation';
import { getReusableAssetForUser } from '@/lib/disburse/reusable-asset-service';

export { brandTemplateInputSchema } from '@/lib/disburse/brand-template-validation';

export const applyBrandTemplateSchema = z.object({
  clipCandidateId: z.coerce.number().int().positive(),
});

function getLayoutRatio(layout: RenderedClipLayout) {
  if (layout === RenderedClipLayout.FACECAM_TOP_50) {
    return '50_50';
  }

  if (layout === RenderedClipLayout.FACECAM_TOP_40) {
    return '40_60';
  }

  if (layout === RenderedClipLayout.FACECAM_TOP_30) {
    return '30_70';
  }

  return null;
}

async function assertReusableAssetKind(
  assetId: number | null,
  userId: number,
  kinds: ReusableAssetKind[],
  label: string
) {
  if (!assetId) {
    return null;
  }

  const asset = await getReusableAssetForUser(assetId, userId);

  if (!asset || !kinds.includes(asset.kind as ReusableAssetKind)) {
    throw new Error(`${label} asset not found.`);
  }

  return asset;
}

async function validateTemplateAssets(input: BrandTemplateInput, userId: number) {
  await Promise.all([
    assertReusableAssetKind(
      input.captionFontAssetId,
      userId,
      [ReusableAssetKind.FONT],
      'Caption font'
    ),
    assertReusableAssetKind(
      input.logoAssetId,
      userId,
      [ReusableAssetKind.IMAGE, ReusableAssetKind.VIDEO],
      'Logo'
    ),
    assertReusableAssetKind(
      input.introVideoAssetId,
      userId,
      [ReusableAssetKind.VIDEO],
      'Intro video'
    ),
    assertReusableAssetKind(
      input.outroVideoAssetId,
      userId,
      [ReusableAssetKind.VIDEO],
      'Outro video'
    ),
  ]);
}

function toInsertValues(input: BrandTemplateInput, userId: number): NewBrandTemplate {
  return {
    userId,
    name: input.name,
    captionFontFamily: input.captionFontFamily?.trim() || null,
    captionFontColor: input.captionFontColor,
    captionHighlightColor: input.captionHighlightColor,
    captionPosition: input.captionPosition,
    captionAnimation: input.captionAnimation,
    captionFontAssetId: input.captionFontAssetId,
    aspectRatio: input.aspectRatio,
    enabledAspectRatios: normalizeEnabledAspectRatios(
      input.enabledAspectRatios,
      input.aspectRatio
    ),
    defaultLayout: input.defaultLayout as RenderedClipLayout,
    enabledLayouts: normalizeEnabledLayouts(
      input.enabledLayouts,
      input.defaultLayout
    ) as RenderedClipLayout[],
    logoAssetId: input.logoAssetId,
    ctaUrl: input.ctaUrl,
    introVideoAssetId: input.introVideoAssetId,
    outroVideoAssetId: input.outroVideoAssetId,
    cropSettings: normalizeCropSettings(input.cropSettings),
    isDefault: input.isDefault,
  };
}

export function toBrandTemplateView(template: BrandTemplate) {
  return {
    id: template.id,
    userId: template.userId,
    name: template.name,
    captions: {
      fontFamily: template.captionFontFamily || '',
      fontColor: template.captionFontColor,
      highlightColor: template.captionHighlightColor,
      position: template.captionPosition,
      animation: template.captionAnimation,
      captionFontAssetId: template.captionFontAssetId,
    },
    layout: {
      aspectRatio: template.aspectRatio,
      enabledAspectRatios: template.enabledAspectRatios,
      defaultLayout: template.defaultLayout,
      enabledLayouts: template.enabledLayouts,
    },
    overlays: {
      logoAssetId: template.logoAssetId,
      ctaUrl: template.ctaUrl,
    },
    introOutro: {
      introVideoAssetId: template.introVideoAssetId,
      outroVideoAssetId: template.outroVideoAssetId,
    },
    cropSettings: template.cropSettings,
    isDefault: template.isDefault,
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
  };
}

export async function listBrandTemplatesForUser(userId: number) {
  return await db.query.brandTemplates.findMany({
    where: eq(brandTemplates.userId, userId),
    orderBy: [desc(brandTemplates.isDefault), desc(brandTemplates.updatedAt)],
  });
}

export async function createBrandTemplate(
  input: BrandTemplateInput,
  user: User
) {
  await validateTemplateAssets(input, user.id);
  const values = toInsertValues(input, user.id);

  return await db.transaction(async (tx) => {
    if (values.isDefault) {
      await tx
        .update(brandTemplates)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(eq(brandTemplates.userId, user.id));
    }

    const [template] = await tx.insert(brandTemplates).values(values).returning();
    return template;
  });
}

export async function updateBrandTemplate(
  templateId: number,
  input: BrandTemplateInput,
  user: User
) {
  await validateTemplateAssets(input, user.id);
  const values = toInsertValues(input, user.id);

  return await db.transaction(async (tx) => {
    const existing = await tx.query.brandTemplates.findFirst({
      where: and(
        eq(brandTemplates.id, templateId),
        eq(brandTemplates.userId, user.id)
      ),
    });

    if (!existing) {
      return null;
    }

    if (values.isDefault) {
      await tx
        .update(brandTemplates)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(eq(brandTemplates.userId, user.id));
    }

    const [template] = await tx
      .update(brandTemplates)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(brandTemplates.id, templateId))
      .returning();

    return template;
  });
}

export async function deleteBrandTemplate(templateId: number, userId: number) {
  const inUse = await db.query.clipEditConfigs.findFirst({
    where: and(
      eq(clipEditConfigs.brandTemplateId, templateId),
      eq(clipEditConfigs.userId, userId)
    ),
    columns: { id: true },
  });

  if (inUse) {
    throw new Error('This template is applied to clips and cannot be deleted.');
  }

  const [template] = await db
    .delete(brandTemplates)
    .where(and(eq(brandTemplates.id, templateId), eq(brandTemplates.userId, userId)))
    .returning();

  return template || null;
}

export async function applyBrandTemplateToClip(params: {
  templateId: number;
  clipCandidateId: number;
  userId: number;
}) {
  const template = await db.query.brandTemplates.findFirst({
    where: and(
      eq(brandTemplates.id, params.templateId),
      eq(brandTemplates.userId, params.userId)
    ),
  });

  if (!template) {
    throw new Error('Brand template not found.');
  }

  const config = await getOrCreateClipEditConfig(
    params.clipCandidateId,
    params.userId
  );
  const layout = template.defaultLayout as RenderedClipLayout;
  const isFacecamLayout = Boolean(getLayoutRatio(layout));
  const nextValues = {
    aspectRatio: template.aspectRatio as ClipEditAspectRatio,
    layout,
    layoutRatio: getLayoutRatio(layout),
    captionsEnabled: config.captionsEnabled,
    captionStyle: config.captionStyle,
    captionFontAssetId: template.captionFontAssetId,
    captionFontFamily: template.captionFontFamily,
    captionFontColor: template.captionFontColor,
    captionHighlightColor: template.captionHighlightColor,
    captionPosition: template.captionPosition,
    captionAnimation: template.captionAnimation,
    brandTemplateId: template.id,
    overlayLogoAssetId: template.logoAssetId,
    ctaUrl: template.ctaUrl,
    introVideoAssetId: template.introVideoAssetId,
    outroVideoAssetId: template.outroVideoAssetId,
    cropSettings: template.cropSettings,
    facecamDetectionId: isFacecamLayout ? config.facecamDetectionId : null,
    facecamDetected: isFacecamLayout ? config.facecamDetected : false,
    autoEditPreset: config.autoEditPreset,
  };
  const nextConfigHash = buildClipEditConfigHash(nextValues);

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

  const renderConfigs = await createRenderConfigsForTemplate({
    template,
    editConfig: updatedConfig,
  });

  return { template, editConfig: updatedConfig, renderConfigs };
}

async function createRenderConfigsForTemplate(params: {
  template: BrandTemplate;
  editConfig: Awaited<ReturnType<typeof getOrCreateClipEditConfig>>;
}) {
  const aspectRatios =
    params.template.enabledAspectRatios?.length > 0
      ? params.template.enabledAspectRatios
      : [params.template.aspectRatio as ClipEditAspectRatio];
  const layouts =
    params.template.enabledLayouts?.length > 0
      ? params.template.enabledLayouts
      : [params.template.defaultLayout as RenderedClipLayout];
  const renderConfigs = [];

  for (const aspectRatio of aspectRatios as ClipEditAspectRatio[]) {
    for (const layout of layouts as RenderedClipLayout[]) {
      const isFacecamLayout = Boolean(getLayoutRatio(layout));
      const nextValues = {
        userId: params.editConfig.userId,
        contentPackId: params.editConfig.contentPackId,
        sourceAssetId: params.editConfig.sourceAssetId,
        clipCandidateId: params.editConfig.clipCandidateId,
        generationRunId: params.editConfig.generationRunId,
        aspectRatio,
        layout,
        layoutRatio: getLayoutRatio(layout),
        captionsEnabled: params.editConfig.captionsEnabled,
        captionStyle: params.editConfig.captionStyle,
        captionFontAssetId: params.template.captionFontAssetId,
        captionFontFamily: params.template.captionFontFamily,
        captionFontColor: params.template.captionFontColor,
        captionHighlightColor: params.template.captionHighlightColor,
        captionPosition: params.template.captionPosition,
        captionAnimation: params.template.captionAnimation,
        brandTemplateId: params.template.id,
        overlayLogoAssetId: params.template.logoAssetId,
        ctaUrl: params.template.ctaUrl,
        introVideoAssetId: params.template.introVideoAssetId,
        outroVideoAssetId: params.template.outroVideoAssetId,
        cropSettings: normalizeCropSettings(params.template.cropSettings),
        facecamDetectionId: isFacecamLayout ? params.editConfig.facecamDetectionId : null,
        facecamDetected: isFacecamLayout ? params.editConfig.facecamDetected : false,
        autoEditPreset: params.editConfig.autoEditPreset,
      };
      const configHash = buildClipEditConfigHash(nextValues);
      const existing = await db.query.clipRenderConfigs.findFirst({
        where: and(
          eq(clipRenderConfigs.clipCandidateId, params.editConfig.clipCandidateId),
          eq(clipRenderConfigs.aspectRatio, aspectRatio),
          eq(clipRenderConfigs.layout, layout),
          eq(clipRenderConfigs.configHash, configHash)
        ),
      });

      if (existing) {
        renderConfigs.push(existing);
        continue;
      }

      const [renderConfig] = await db
        .insert(clipRenderConfigs)
        .values({ ...nextValues, configHash } satisfies NewClipRenderConfig)
        .returning();

      renderConfigs.push(renderConfig);
    }
  }

  return renderConfigs;
}
