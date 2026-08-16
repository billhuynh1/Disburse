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
import { toBrandTemplateView } from '@/lib/disburse/brand-template-view';

export { brandTemplateInputSchema } from '@/lib/disburse/brand-template-validation';
export { toBrandTemplateView } from '@/lib/disburse/brand-template-view';

export const applyBrandTemplateSchema = z.object({
  clipCandidateId: z.coerce.number().int().positive(),
});

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = typeof db | DbTransaction;

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

export function isFacecamTemplateLayout(layout: RenderedClipLayout) {
  return Boolean(getLayoutRatio(layout));
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
    captionStyle: input.captionStyle,
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
    captionStyle: template.captionStyle,
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

export async function createRenderConfigsForTemplate(
  params: {
    template: BrandTemplate;
    editConfig: Awaited<ReturnType<typeof getOrCreateClipEditConfig>>;
  },
  executor: DbLike = db
) {
  const expectedConfigs = deriveExpectedRenderConfigsForTemplate(params);
  const renderConfigs = [];

  for (const expectedConfig of expectedConfigs) {
    const existing = await executor.query.clipRenderConfigs.findFirst({
      where: and(
        eq(clipRenderConfigs.clipCandidateId, params.editConfig.clipCandidateId),
        eq(clipRenderConfigs.aspectRatio, expectedConfig.aspectRatio!),
        eq(clipRenderConfigs.layout, expectedConfig.layout!),
        eq(clipRenderConfigs.configHash, expectedConfig.configHash)
      ),
    });

    if (existing) {
      renderConfigs.push(existing);
      continue;
    }

    const [renderConfig] = await executor
      .insert(clipRenderConfigs)
      .values(expectedConfig)
      .returning();

    renderConfigs.push(renderConfig);
  }

  return renderConfigs;
}

function deriveExpectedRenderConfigsForTemplate(params: {
  template: BrandTemplate;
  editConfig: Awaited<ReturnType<typeof getOrCreateClipEditConfig>>;
}): NewClipRenderConfig[] {
  const aspectRatios =
    params.template.enabledAspectRatios?.length > 0
      ? params.template.enabledAspectRatios
      : [params.template.aspectRatio as ClipEditAspectRatio];
  const layouts =
    params.template.enabledLayouts?.length > 0
      ? params.template.enabledLayouts
      : [params.template.defaultLayout as RenderedClipLayout];
  const renderConfigs: NewClipRenderConfig[] = [];

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
      renderConfigs.push({ ...nextValues, configHash });
    }
  }

  return renderConfigs;
}

export async function isRenderConfigInCurrentExpectedSet(params: {
  editConfig: Awaited<ReturnType<typeof getOrCreateClipEditConfig>>;
  renderConfig: typeof clipRenderConfigs.$inferSelect;
}, executor: DbLike = db, options: { lock?: boolean } = {}) {
  if (!params.editConfig.brandTemplateId) {
    return false;
  }

  const templateQuery = executor.select().from(brandTemplates).where(and(
    eq(brandTemplates.id, params.editConfig.brandTemplateId),
    eq(brandTemplates.userId, params.editConfig.userId)
  ));
  const [template] = options.lock
    ? await templateQuery.for('update').limit(1)
    : await templateQuery.limit(1);

  if (!template) {
    return false;
  }

  return deriveExpectedRenderConfigsForTemplate({
    template,
    editConfig: params.editConfig,
  }).some((expected) =>
    expected.userId === params.renderConfig.userId &&
    expected.contentPackId === params.renderConfig.contentPackId &&
    expected.sourceAssetId === params.renderConfig.sourceAssetId &&
    expected.clipCandidateId === params.renderConfig.clipCandidateId &&
    expected.generationRunId === params.renderConfig.generationRunId &&
    expected.aspectRatio === params.renderConfig.aspectRatio &&
    expected.layout === params.renderConfig.layout &&
    expected.configHash === params.renderConfig.configHash &&
    (!isFacecamTemplateLayout(params.renderConfig.layout as RenderedClipLayout) ||
      params.renderConfig.facecamDetected)
  );
}

export async function getCurrentExpectedRenderConfigsForEditConfig(
  editConfig: Awaited<ReturnType<typeof getOrCreateClipEditConfig>>,
  executor: DbLike = db
) {
  const renderConfigs = await createRenderableRenderConfigsForEditConfig(
    editConfig,
    executor
  );

  return renderConfigs.length > 0 ? renderConfigs : [editConfig];
}

export async function createRenderableRenderConfigsForEditConfig(
  editConfig: Awaited<ReturnType<typeof getOrCreateClipEditConfig>>,
  executor: DbLike = db
) {
  if (!editConfig.brandTemplateId) {
    return [];
  }

  const template = await executor.query.brandTemplates.findFirst({
    where: and(
      eq(brandTemplates.id, editConfig.brandTemplateId),
      eq(brandTemplates.userId, editConfig.userId)
    ),
  });

  if (!template) {
    return [];
  }

  const renderConfigs = await createRenderConfigsForTemplate(
    {
      template,
      editConfig,
    },
    executor
  );

  return renderConfigs.filter(
    (renderConfig) =>
      !isFacecamTemplateLayout(renderConfig.layout as RenderedClipLayout) ||
      renderConfig.facecamDetected
  );
}
