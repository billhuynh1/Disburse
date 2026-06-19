import { z } from 'zod';

export const captionPositions = ['top', 'middle', 'bottom', 'manual'] as const;
export const captionAnimations = ['none', 'pop', 'fade'] as const;
export const aspectRatios = ['9_16', '1_1', '16_9'] as const;
export const sourceCropPresets = ['original', '4_3', '1_1'] as const;
export const editableLayouts = [
  'preserve_aspect',
  'default',
  'facecam_top_50',
  'facecam_top_40',
  'facecam_top_30',
] as const;

const splitLayouts = [
  'facecam_top_50',
  'facecam_top_40',
  'facecam_top_30',
] as const;

const optionalAssetId = z
  .union([z.coerce.number().int().positive(), z.literal(''), z.null()])
  .optional()
  .transform((value) => (value === '' || value == null ? null : value));

const normalizedUnitIntervalSchema = z
  .number()
  .finite()
  .transform((value) => Math.min(1, Math.max(0, value)));

export const captionPlacementSchema = z.object({
  x: normalizedUnitIntervalSchema,
  y: normalizedUnitIntervalSchema,
});

export const captionPlacementsSchema = z
  .object({
    '9_16': captionPlacementSchema.optional(),
    '1_1': captionPlacementSchema.optional(),
    '16_9': captionPlacementSchema.optional(),
  })
  .partial();

export const cropSettingsSchema = z
  .object({
    sourceCrop: z.enum(sourceCropPresets).default('original'),
    captionPlacements: captionPlacementsSchema.optional(),
    previewCaptionText: z.string().trim().min(1).max(160).optional(),
  })
  .passthrough();

export const brandTemplateInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  captionFontFamily: z.string().trim().max(120).optional().nullable(),
  captionFontColor: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).default('#ffffff'),
  captionHighlightColor: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).default('#facc15'),
  captionPosition: z.enum(captionPositions).default('bottom'),
  captionAnimation: z.enum(captionAnimations).default('none'),
  captionFontAssetId: optionalAssetId,
  aspectRatio: z.enum(aspectRatios).default('9_16'),
  enabledAspectRatios: z.array(z.enum(aspectRatios)).min(1).default(['9_16']),
  defaultLayout: z.enum(editableLayouts).default('default'),
  enabledLayouts: z.array(z.enum(editableLayouts)).min(1).default([
    'default',
  ]),
  logoAssetId: optionalAssetId,
  ctaUrl: z
    .union([z.string().trim().url().max(500), z.literal(''), z.null()])
    .optional()
    .transform((value) => (value ? value : null)),
  introVideoAssetId: optionalAssetId,
  outroVideoAssetId: optionalAssetId,
  cropSettings: cropSettingsSchema.optional().default({ sourceCrop: 'original' }),
  isDefault: z.coerce.boolean().optional().default(false),
});

export type BrandTemplateInput = z.infer<typeof brandTemplateInputSchema>;
export type BrandTemplateAspectRatio = (typeof aspectRatios)[number];
export type CaptionPosition = (typeof captionPositions)[number];
export type CaptionPlacement = z.infer<typeof captionPlacementSchema>;
export type CaptionPlacements = z.infer<typeof captionPlacementsSchema>;
export type BrandTemplateLayout = (typeof editableLayouts)[number];
export type BrandTemplateCropSettings = z.infer<typeof cropSettingsSchema>;

export function normalizeCropSettings(
  cropSettings?: Record<string, unknown> | null
): BrandTemplateCropSettings {
  return cropSettingsSchema.parse(cropSettings ?? { sourceCrop: 'original' });
}

function isSplitLayout(layout: BrandTemplateLayout) {
  return splitLayouts.includes(layout as (typeof splitLayouts)[number]);
}

export function normalizeEnabledLayouts(
  enabledLayouts: BrandTemplateLayout[],
  defaultLayout: BrandTemplateLayout
) {
  const normalizedLayouts: BrandTemplateLayout[] = [];
  let hasSplitLayout = false;

  for (const layout of Array.from(new Set([defaultLayout, ...enabledLayouts]))) {
    if (isSplitLayout(layout)) {
      if (hasSplitLayout) {
        continue;
      }

      hasSplitLayout = true;
    }

    normalizedLayouts.push(layout);
  }

  return normalizedLayouts;
}

export function normalizeEnabledAspectRatios(
  enabledAspectRatios: BrandTemplateAspectRatio[],
  aspectRatio: BrandTemplateAspectRatio
) {
  return Array.from(new Set([aspectRatio, ...enabledAspectRatios]));
}
