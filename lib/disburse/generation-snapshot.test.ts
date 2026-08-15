import assert from 'node:assert/strict';
import test from 'node:test';

import { RenderedClipLayout } from '../db/schema.ts';
import {
  InvalidGenerationSnapshotError,
  UnsupportedGenerationSnapshotVersionError,
  materializeGenerationSnapshot,
  parseGenerationSnapshot,
  serializeGenerationSnapshot,
  type GenerationSnapshotV1,
} from './generation-snapshot.ts';

const validSnapshot: GenerationSnapshotV1 = {
  version: 1,
  brandTemplateId: 42,
  ranking: {
    generationInstructions: 'Prioritize decisive strategy moments.',
    clipLength: '30-60s',
    minDurationMs: 30_000,
    targetDurationMs: 45_000,
    maxDurationMs: 60_000,
    maxExcerptChars: 1_200,
    autoHookEnabled: true,
    contentPackage: 'clips_only',
  },
  facecam: {
    detectionEnabled: true,
    detectorVersion: 'facecam_v1',
    preferredLayout: RenderedClipLayout.FACECAM_TOP_40,
    fallbackLayout: RenderedClipLayout.DEFAULT,
  },
  render: {
    aspectRatio: '9_16',
    captionsEnabled: true,
    captionStyle: 'default',
    captionFontAssetId: null,
    captionFontFamily: null,
    captionFontColor: '#ffffff',
    captionHighlightColor: '#facc15',
    captionPosition: 'bottom',
    captionAnimation: 'none',
    overlayLogoAssetId: null,
    introVideoAssetId: null,
    outroVideoAssetId: null,
    ctaUrl: null,
    cropSettings: { sourceCrop: 'original' },
    autoEditPreset: 'default_short_form_v1',
  },
};

test('parses a valid V1 generation snapshot', () => {
  assert.deepEqual(parseGenerationSnapshot(validSnapshot), validSnapshot);
});

test('rejects unsupported, malformed, and unknown generation snapshot fields', () => {
  assert.throws(
    () => parseGenerationSnapshot({ ...validSnapshot, version: 2 }),
    UnsupportedGenerationSnapshotVersionError
  );
  assert.throws(
    () => parseGenerationSnapshot({ ...validSnapshot, unknown: true }),
    InvalidGenerationSnapshotError
  );
  assert.throws(
    () => parseGenerationSnapshot({
      ...validSnapshot,
      render: { ...validSnapshot.render, aspectRatio: '4_5' },
    }),
    InvalidGenerationSnapshotError
  );
  assert.throws(
    () => parseGenerationSnapshot({
      ...validSnapshot,
      ranking: { ...validSnapshot.ranking, minDurationMs: 60_001 },
    }),
    InvalidGenerationSnapshotError
  );
  assert.throws(
    () => parseGenerationSnapshot({
      ...validSnapshot,
      render: {
        ...validSnapshot.render,
        cropSettings: { ...validSnapshot.render.cropSettings, editorOnly: true },
      },
    }),
    InvalidGenerationSnapshotError
  );
});

test('serializes only snapshots that pass canonical validation', () => {
  const serialized = serializeGenerationSnapshot(validSnapshot);
  assert.deepEqual(serialized, validSnapshot);
  assert.notEqual(serialized, validSnapshot);
  assert.throws(
    () => serializeGenerationSnapshot({ ...validSnapshot, brandTemplateId: 0 }),
    InvalidGenerationSnapshotError
  );
});

test('materializes a singular render policy from rich legacy source input', () => {
  const snapshot = materializeGenerationSnapshot({
    brandTemplateId: 42,
    ranking: {
      generationInstructions: null,
      clipLength: '15-30s',
      autoHookEnabled: false,
      contentPackage: 'clips_x_posts',
      name: 'Legacy template ranking metadata',
      isDefault: true,
    },
    facecam: {
      detectionEnabled: true,
      detectorVersion: 'facecam_v2',
      preferredLayout: RenderedClipLayout.FACECAM_TOP_30,
      fallbackLayout: RenderedClipLayout.PRESERVE_ASPECT,
      enabledLayouts: [
        RenderedClipLayout.DEFAULT,
        RenderedClipLayout.FACECAM_TOP_30,
      ],
    },
    render: {
      aspectRatio: '1_1',
      captionsEnabled: true,
      captionStyle: 'single_word',
      captionFontAssetId: 7,
      captionFontFamily: 'Inter',
      captionFontColor: '#101010',
      captionHighlightColor: '#f0f000',
      captionPosition: 'middle',
      captionAnimation: 'pop',
      overlayLogoAssetId: 8,
      introVideoAssetId: 9,
      outroVideoAssetId: 10,
      ctaUrl: 'https://example.com/subscribe',
      cropSettings: {
        sourceCrop: '4_3',
        captionPlacements: {
          '9_16': { x: 0.5, y: 0.8 },
        },
        previewCaptionText: 'Editor-only preview',
        captionShadow: { enabled: true },
      },
      autoEditPreset: 'custom_short_form_v1',
      enabledAspectRatios: ['9_16', '1_1', '16_9'],
      name: 'Legacy template render metadata',
      isDefault: false,
      createdAt: '2026-08-14T00:00:00.000Z',
    },
  });

  assert.equal(snapshot.brandTemplateId, 42);
  assert.equal(snapshot.render.aspectRatio, '1_1');
  assert.equal(snapshot.facecam.preferredLayout, RenderedClipLayout.FACECAM_TOP_30);
  assert.equal(snapshot.facecam.fallbackLayout, RenderedClipLayout.PRESERVE_ASPECT);
  assert.deepEqual(snapshot.ranking, {
    generationInstructions: '',
    clipLength: '15-30s',
    minDurationMs: 15_000,
    targetDurationMs: 22_500,
    maxDurationMs: 30_000,
    maxExcerptChars: 900,
    autoHookEnabled: false,
    contentPackage: 'clips_x_posts',
  });
  assert.equal('enabledAspectRatios' in snapshot.render, false);
  assert.equal('enabledLayouts' in snapshot.facecam, false);
  assert.equal('name' in snapshot.render, false);
  assert.equal('isDefault' in snapshot.ranking, false);
  assert.deepEqual(snapshot.render.cropSettings, {
    sourceCrop: '4_3',
    captionPlacements: {
      '9_16': { x: 0.5, y: 0.8 },
    },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)).render.cropSettings, {
    sourceCrop: '4_3',
    captionPlacements: {
      '9_16': { x: 0.5, y: 0.8 },
    },
  });
});
