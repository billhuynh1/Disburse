import { z } from 'zod';

import { RenderedClipLayout } from '@/lib/db/schema';
import { captionStyles } from '@/lib/disburse/caption-style';
import {
  captionAnimations,
  captionPositions,
  sourceCropPresets,
} from '@/lib/disburse/brand-template-validation';
import { type ClipEditAspectRatio } from '@/lib/disburse/clip-edit-config-utils';
import {
  CONTENT_PACKAGE_VALUES,
  type ContentPackageValue,
} from '@/lib/disburse/content-package-config';
import {
  getShortFormClipWindowConfig,
  SHORT_FORM_CLIP_LENGTH_VALUES,
  type ShortFormClipLengthValue,
} from '@/lib/disburse/short-form-setup-config';

const positiveIdSchema = z.number().int().positive();
const nullablePositiveIdSchema = positiveIdSchema.nullable();
const aspectRatioSchema = z.enum(['9_16', '1_1', '16_9']);
const renderedClipLayoutSchema = z.nativeEnum(RenderedClipLayout);
const fallbackLayoutSchema = z.union([
  z.literal(RenderedClipLayout.DEFAULT),
  z.literal(RenderedClipLayout.PRESERVE_ASPECT),
]);
const finitePositiveNumberSchema = z.number().finite().positive();

const normalizedUnitIntervalSchema = z
  .number()
  .finite()
  .transform((value) => Math.min(1, Math.max(0, value)));
const cropCaptionPlacementSchema = z
  .object({
    x: normalizedUnitIntervalSchema,
    y: normalizedUnitIntervalSchema,
  })
  .strict();
const cropCaptionPlacementsSchema = z
  .object({
    '9_16': cropCaptionPlacementSchema.optional(),
    '1_1': cropCaptionPlacementSchema.optional(),
    '16_9': cropCaptionPlacementSchema.optional(),
  })
  .strict();
const cropSettingsSchema = z
  .object({
    sourceCrop: z.enum(sourceCropPresets),
    captionPlacements: cropCaptionPlacementsSchema.optional(),
    captionHighlightEnabled: z.boolean().optional(),
  })
  .strict();

export const generationSnapshotV1Schema = z
  .object({
    version: z.literal(1),
    brandTemplateId: nullablePositiveIdSchema,
    ranking: z
      .object({
        generationInstructions: z.string().max(10_000),
        clipLength: z.enum(SHORT_FORM_CLIP_LENGTH_VALUES),
        minDurationMs: finitePositiveNumberSchema,
        targetDurationMs: finitePositiveNumberSchema,
        maxDurationMs: finitePositiveNumberSchema,
        maxExcerptChars: z.number().int().positive().max(100_000),
        autoHookEnabled: z.boolean(),
        contentPackage: z.enum(CONTENT_PACKAGE_VALUES),
      })
      .strict()
      .superRefine((ranking, context) => {
        if (ranking.minDurationMs > ranking.targetDurationMs) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['minDurationMs'],
            message: 'minDurationMs must be less than or equal to targetDurationMs',
          });
        }

        if (ranking.targetDurationMs > ranking.maxDurationMs) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['targetDurationMs'],
            message: 'targetDurationMs must be less than or equal to maxDurationMs',
          });
        }
      }),
    facecam: z
      .object({
        detectionEnabled: z.boolean(),
        detectorVersion: z.string().trim().min(1).max(120),
        preferredLayout: renderedClipLayoutSchema,
        fallbackLayout: fallbackLayoutSchema,
      })
      .strict(),
    render: z
      .object({
        aspectRatio: aspectRatioSchema,
        captionsEnabled: z.boolean(),
        captionStyle: z.enum(captionStyles),
        captionFontAssetId: nullablePositiveIdSchema,
        captionFontFamily: z.string().trim().min(1).max(120).nullable(),
        captionFontColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        captionHighlightColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        captionPosition: z.enum(captionPositions),
        captionAnimation: z.enum(captionAnimations),
        overlayLogoAssetId: nullablePositiveIdSchema,
        introVideoAssetId: nullablePositiveIdSchema,
        outroVideoAssetId: nullablePositiveIdSchema,
        ctaUrl: z.string().url().max(500).nullable(),
        cropSettings: cropSettingsSchema,
        autoEditPreset: z.string().trim().min(1).max(80),
      })
      .strict(),
  })
  .strict();

export type GenerationSnapshotV1 = z.infer<typeof generationSnapshotV1Schema>;

function normalizeSnapshotCropSettings(
  cropSettings: Record<string, unknown> | null | undefined
): z.infer<typeof cropSettingsSchema> {
  const sourceCrop = z
    .enum(sourceCropPresets)
    .optional()
    .default('original')
    .parse(cropSettings?.sourceCrop);
  const rawCaptionPlacements = cropSettings?.captionPlacements;
  const rawCaptionHighlightEnabled = cropSettings?.captionHighlightEnabled;
  const captionHighlightEnabled =
    typeof rawCaptionHighlightEnabled === 'boolean'
      ? rawCaptionHighlightEnabled
      : undefined;

  if (rawCaptionPlacements === undefined) {
    return {
      sourceCrop,
      ...(captionHighlightEnabled === undefined
        ? {}
        : { captionHighlightEnabled }),
    };
  }

  const captionPlacements = cropCaptionPlacementsSchema.parse(
    rawCaptionPlacements
  );

  return {
    sourceCrop,
    ...(Object.keys(captionPlacements).length > 0 ? { captionPlacements } : {}),
    ...(captionHighlightEnabled === undefined
      ? {}
      : { captionHighlightEnabled }),
  };
}

export class UnsupportedGenerationSnapshotVersionError extends Error {
  constructor(version: unknown) {
    super(`Unsupported generation snapshot version: ${String(version)}`);
    this.name = 'UnsupportedGenerationSnapshotVersionError';
  }
}

export class InvalidGenerationSnapshotError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InvalidGenerationSnapshotError';
  }
}

function cloneSnapshot(snapshot: GenerationSnapshotV1): GenerationSnapshotV1 {
  return JSON.parse(JSON.stringify(snapshot)) as GenerationSnapshotV1;
}

export function parseGenerationSnapshot(raw: unknown): GenerationSnapshotV1 {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidGenerationSnapshotError('Generation snapshot must be an object.');
  }

  const version = (raw as { version?: unknown }).version;
  if (version !== 1) {
    throw new UnsupportedGenerationSnapshotVersionError(version);
  }

  try {
    return cloneSnapshot(generationSnapshotV1Schema.parse(raw));
  } catch (error) {
    throw new InvalidGenerationSnapshotError('Generation snapshot V1 is invalid.', {
      cause: error,
    });
  }
}

export function serializeGenerationSnapshot(snapshot: unknown): GenerationSnapshotV1 {
  return parseGenerationSnapshot(snapshot);
}

export type GenerationSnapshotMaterializationInput = {
  brandTemplateId: number | null;
  ranking: {
    generationInstructions: string | null | undefined;
    clipLength: ShortFormClipLengthValue;
    autoHookEnabled: boolean;
    contentPackage: ContentPackageValue;
  } & Record<string, unknown>;
  facecam: {
    detectionEnabled: boolean;
    detectorVersion: string;
    preferredLayout: RenderedClipLayout;
    fallbackLayout:
      | RenderedClipLayout.DEFAULT
      | RenderedClipLayout.PRESERVE_ASPECT;
  } & Record<string, unknown>;
  render: {
    aspectRatio: ClipEditAspectRatio;
    captionsEnabled: boolean;
    captionStyle: (typeof captionStyles)[number];
    captionFontAssetId: number | null;
    captionFontFamily: string | null;
    captionFontColor: string;
    captionHighlightColor: string;
    captionPosition: (typeof captionPositions)[number];
    captionAnimation: (typeof captionAnimations)[number];
    overlayLogoAssetId: number | null;
    introVideoAssetId: number | null;
    outroVideoAssetId: number | null;
    ctaUrl: string | null;
    cropSettings: Record<string, unknown> | null | undefined;
    autoEditPreset: string;
  } & Record<string, unknown>;
};

export function materializeGenerationSnapshot(
  input: GenerationSnapshotMaterializationInput
): GenerationSnapshotV1 {
  const duration = getShortFormClipWindowConfig(input.ranking.clipLength);

  return serializeGenerationSnapshot({
    version: 1,
    brandTemplateId: input.brandTemplateId,
    ranking: {
      generationInstructions: input.ranking.generationInstructions ?? '',
      clipLength: input.ranking.clipLength,
      minDurationMs: duration.minDurationMs,
      targetDurationMs: duration.targetDurationMs,
      maxDurationMs: duration.maxDurationMs,
      maxExcerptChars: duration.maxExcerptChars,
      autoHookEnabled: input.ranking.autoHookEnabled,
      contentPackage: input.ranking.contentPackage,
    },
    facecam: {
      detectionEnabled: input.facecam.detectionEnabled,
      detectorVersion: input.facecam.detectorVersion,
      preferredLayout: input.facecam.preferredLayout,
      fallbackLayout: input.facecam.fallbackLayout,
    },
    render: {
      aspectRatio: input.render.aspectRatio,
      captionsEnabled: input.render.captionsEnabled,
      captionStyle: input.render.captionStyle,
      captionFontAssetId: input.render.captionFontAssetId,
      captionFontFamily: input.render.captionFontFamily,
      captionFontColor: input.render.captionFontColor,
      captionHighlightColor: input.render.captionHighlightColor,
      captionPosition: input.render.captionPosition,
      captionAnimation: input.render.captionAnimation,
      overlayLogoAssetId: input.render.overlayLogoAssetId,
      introVideoAssetId: input.render.introVideoAssetId,
      outroVideoAssetId: input.render.outroVideoAssetId,
      ctaUrl: input.render.ctaUrl,
      cropSettings: normalizeSnapshotCropSettings(input.render.cropSettings),
      autoEditPreset: input.render.autoEditPreset,
    },
  });
}
