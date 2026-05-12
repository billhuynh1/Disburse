import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildClipEditConfigHash,
  DEFAULT_CLIP_AUTO_EDIT_PRESET,
  DEFAULT_CLIP_CAPTION_STYLE,
  DEFAULT_CLIP_LAYOUT,
  DEFAULT_FACECAM_LAYOUT,
  hasClipEditConfigSettingsChanged,
  isRenderedClipCurrentForEditConfig,
  getRenderedClipVariantForEditConfig,
} from './clip-edit-config-utils.ts';
import { RenderedClipVariant } from '../db/schema.ts';

test('builds deterministic hashes from canonical edit config fields', () => {
  const config = {
    aspectRatio: '9_16',
    layout: DEFAULT_CLIP_LAYOUT,
    layoutRatio: null,
    captionsEnabled: true,
    captionStyle: DEFAULT_CLIP_CAPTION_STYLE,
    captionFontAssetId: null,
    facecamDetectionId: null,
    facecamDetected: false,
    autoEditPreset: DEFAULT_CLIP_AUTO_EDIT_PRESET,
  };

  assert.equal(buildClipEditConfigHash(config), buildClipEditConfigHash(config));
  assert.notEqual(
    buildClipEditConfigHash(config),
    buildClipEditConfigHash({
      ...config,
      layout: DEFAULT_FACECAM_LAYOUT,
      layoutRatio: '40_60',
      facecamDetectionId: 10,
      facecamDetected: true,
    })
  );
});

test('maps edit config aspect ratios to rendered artifact variants', () => {
  assert.equal(
    getRenderedClipVariantForEditConfig({ aspectRatio: '9_16' }),
    RenderedClipVariant.VERTICAL_SHORT_FORM
  );
  assert.equal(
    getRenderedClipVariantForEditConfig({ aspectRatio: '1_1' }),
    RenderedClipVariant.SQUARE_SHORT_FORM
  );
  assert.equal(
    getRenderedClipVariantForEditConfig({ aspectRatio: '16_9' }),
    RenderedClipVariant.LANDSCAPE_SHORT_FORM
  );
});

test('detects edit setting changes from canonical hashes only', () => {
  const config = {
    aspectRatio: '9_16',
    layout: DEFAULT_CLIP_LAYOUT,
    layoutRatio: null,
    captionsEnabled: true,
    captionStyle: DEFAULT_CLIP_CAPTION_STYLE,
    captionFontAssetId: null,
    facecamDetectionId: null,
    facecamDetected: false,
    autoEditPreset: DEFAULT_CLIP_AUTO_EDIT_PRESET,
  };
  const current = { configHash: buildClipEditConfigHash(config) };

  assert.equal(hasClipEditConfigSettingsChanged(current, config), false);
  assert.equal(
    hasClipEditConfigSettingsChanged(current, {
      ...config,
      captionsEnabled: false,
    }),
    true
  );
});

test('treats rendered clips as current by config version or hash', () => {
  const editConfig = {
    configVersion: 3,
    configHash: 'hash-current',
  };

  assert.equal(
    isRenderedClipCurrentForEditConfig(
      { editConfigVersion: 3, editConfigHash: 'hash-old' },
      editConfig
    ),
    true
  );
  assert.equal(
    isRenderedClipCurrentForEditConfig(
      { editConfigVersion: 2, editConfigHash: 'hash-current' },
      editConfig
    ),
    true
  );
  assert.equal(
    isRenderedClipCurrentForEditConfig(
      { editConfigVersion: 2, editConfigHash: 'hash-old' },
      editConfig
    ),
    false
  );
});
