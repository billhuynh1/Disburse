import type { BrandTemplate } from '../db/schema.ts';
import {
  captionShadowSchema,
  normalizeCropSettings,
} from './brand-template-validation.ts';

export function toBrandTemplateView(template: BrandTemplate) {
  const cropSettings = normalizeCropSettings(template.cropSettings);

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
      shadow: captionShadowSchema.parse(cropSettings.captionShadow ?? {}),
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
    cropSettings,
    isDefault: template.isDefault,
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
  };
}
