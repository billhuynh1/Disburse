import { createHash } from 'node:crypto';
import {
  RenderedClipLayout,
  RenderedClipVariant,
  type ClipEditConfig,
} from '../db/schema.ts';

export type ClipEditAspectRatio = '9_16' | '1_1' | '16_9';

export const DEFAULT_CLIP_AUTO_EDIT_PRESET = 'default_short_form_v1';
export const DEFAULT_CLIP_CAPTION_STYLE = 'default';
export const DEFAULT_CLIP_ASPECT_RATIO: ClipEditAspectRatio = '9_16';
export const DEFAULT_CLIP_LAYOUT = RenderedClipLayout.DEFAULT;
export const DEFAULT_FACECAM_LAYOUT = RenderedClipLayout.FACECAM_TOP_40;
export const DEFAULT_FACECAM_LAYOUT_RATIO = '40_60';

export type HashableClipEditConfig = Pick<
  ClipEditConfig,
  | 'aspectRatio'
  | 'layout'
  | 'layoutRatio'
  | 'captionsEnabled'
  | 'captionStyle'
  | 'captionFontAssetId'
  | 'facecamDetectionId'
  | 'facecamDetected'
  | 'autoEditPreset'
>;

function canonicalizeClipEditConfig(config: HashableClipEditConfig) {
  return JSON.stringify({
    aspectRatio: config.aspectRatio,
    layout: config.layout,
    layoutRatio: config.layoutRatio,
    captionsEnabled: config.captionsEnabled,
    captionStyle: config.captionStyle,
    captionFontAssetId: config.captionFontAssetId,
    facecamDetectionId: config.facecamDetectionId,
    facecamDetected: config.facecamDetected,
    autoEditPreset: config.autoEditPreset,
  });
}

export function buildClipEditConfigHash(config: HashableClipEditConfig) {
  return createHash('sha256')
    .update(canonicalizeClipEditConfig(config))
    .digest('hex');
}

export function hasClipEditConfigSettingsChanged(
  current: Pick<ClipEditConfig, 'configHash'>,
  nextValues: HashableClipEditConfig
) {
  return current.configHash !== buildClipEditConfigHash(nextValues);
}

export function isRenderedClipCurrentForEditConfig(
  renderedClip: {
    editConfigVersion?: number | null;
    editConfigHash?: string | null;
  },
  editConfig: Pick<ClipEditConfig, 'configVersion' | 'configHash'>
) {
  return (
    renderedClip.editConfigVersion === editConfig.configVersion ||
    renderedClip.editConfigHash === editConfig.configHash
  );
}

export function getRenderedClipVariantForEditConfig(
  config: Pick<ClipEditConfig, 'aspectRatio'>
) {
  if (config.aspectRatio === '1_1') {
    return RenderedClipVariant.SQUARE_SHORT_FORM;
  }

  if (config.aspectRatio === '16_9') {
    return RenderedClipVariant.LANDSCAPE_SHORT_FORM;
  }

  return RenderedClipVariant.VERTICAL_SHORT_FORM;
}
