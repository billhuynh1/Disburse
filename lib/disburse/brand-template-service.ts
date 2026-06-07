import 'server-only';

import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db/drizzle';
import {
  brandTemplates,
  clipEditConfigs,
  RenderedClipLayout,
  ReusableAssetKind,
  type BrandTemplate,
  type NewBrandTemplate,
  type User,
} from '@/lib/db/schema';
import {
  buildClipEditConfigHash,
  getOrCreateClipEditConfig,
  type ClipEditAspectRatio,
} from '@/lib/disburse/clip-edit-config-service';
import { getReusableAssetForUser } from '@/lib/disburse/reusable-asset-service';

const captionPositions = ['top', 'middle', 'bottom'] as const;
const captionAnimations = ['none', 'pop', 'fade'] as const;
const aspectRatios = ['9_16', '1_1', '16_9'] as const;
const editableLayouts = [
  RenderedClipLayout.PRESERVE_ASPECT,
  RenderedClipLayout.DEFAULT,
  RenderedClipLayout.FACECAM_TOP_50,
  RenderedClipLayout.FACECAM_TOP_40,
  RenderedClipLayout.FACECAM_TOP_30,
] as const;

const optionalAssetId = z
  .union([z.coerce.number().int().positive(), z.literal(''), z.null()])
  .optional()
  .transform((value) => (value === '' || value == null ? null : value));

export const brandTemplateInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  captionFontFamily: z.string().trim().max(120).optional().nullable(),
  captionFontColor: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).default('#ffffff'),
  captionHighlightColor: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).default('#facc15'),
  captionPosition: z.enum(captionPositions).default('bottom'),
  captionAnimation: z.enum(captionAnimations).default('none'),
  captionFontAssetId: optionalAssetId,
  aspectRatio: z.enum(aspectRatios).default('9_16'),
  defaultLayout: z.enum(editableLayouts).default(RenderedClipLayout.DEFAULT),
  enabledLayouts: z.array(z.enum(editableLayouts)).min(1).default([
    RenderedClipLayout.DEFAULT,
  ]),
  logoAssetId: optionalAssetId,
  ctaUrl: z
    .union([z.string().trim().url().max(500), z.literal(''), z.null()])
    .optional()
    .transform((value) => (value ? value : null)),
  introVideoAssetId: optionalAssetId,
  outroVideoAssetId: optionalAssetId,
  cropSettings: z.record(z.unknown()).optional().default({}),
  isDefault: z.coerce.boolean().optional().default(false),
});

export const applyBrandTemplateSchema = z.object({
  clipCandidateId: z.coerce.number().int().positive(),
});

export type BrandTemplateInput = z.infer<typeof brandTemplateInputSchema>;

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

function normalizeEnabledLayouts(
  enabledLayouts: RenderedClipLayout[],
  defaultLayout: RenderedClipLayout
) {
  return Array.from(new Set([defaultLayout, ...enabledLayouts]));
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
    defaultLayout: input.defaultLayout,
    enabledLayouts: normalizeEnabledLayouts(
      input.enabledLayouts,
      input.defaultLayout
    ),
    logoAssetId: input.logoAssetId,
    ctaUrl: input.ctaUrl,
    introVideoAssetId: input.introVideoAssetId,
    outroVideoAssetId: input.outroVideoAssetId,
    cropSettings: input.cropSettings,
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

  return { template, editConfig: updatedConfig };
}
