import test from 'node:test';
import assert from 'node:assert/strict';
import { RenderedClipLayout, type BrandTemplate } from '../db/schema.ts';
import { toBrandTemplateView } from './brand-template-view.ts';

function createTemplate(
  cropSettings: Record<string, unknown> = {}
): BrandTemplate {
  return {
    id: 1,
    userId: 2,
    name: 'Launch clips',
    captionStyle: 'default',
    captionFontFamily: 'Arial',
    captionFontColor: '#ffffff',
    captionHighlightColor: '#facc15',
    captionPosition: 'bottom',
    captionAnimation: 'none',
    captionFontAssetId: null,
    aspectRatio: '9_16',
    enabledAspectRatios: ['9_16'],
    defaultLayout: RenderedClipLayout.DEFAULT,
    enabledLayouts: [RenderedClipLayout.DEFAULT],
    logoAssetId: null,
    ctaUrl: null,
    introVideoAssetId: null,
    outroVideoAssetId: null,
    cropSettings,
    isDefault: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

test('toBrandTemplateView returns stable default caption shadow values', () => {
  const view = toBrandTemplateView(createTemplate());

  assert.deepEqual(view.captions.shadow, {
    enabled: false,
    color: '#000000',
    size: 'medium',
    style: 'solid',
  });
  assert.deepEqual(view.cropSettings.captionShadow, {
    enabled: false,
    color: '#000000',
    size: 'medium',
    style: 'solid',
  });
});

test('toBrandTemplateView preserves stored caption shadow values', () => {
  const view = toBrandTemplateView(
    createTemplate({
      sourceCrop: 'original',
      captionShadow: {
        enabled: true,
        color: '#101010',
        size: 'large',
        style: 'soft',
      },
    })
  );

  assert.deepEqual(view.captions.shadow, {
    enabled: true,
    color: '#101010',
    size: 'large',
    style: 'soft',
  });
});

test('toBrandTemplateView includes caption style', () => {
  const view = toBrandTemplateView(createTemplate());

  assert.equal(view.captions.style, 'default');
});
