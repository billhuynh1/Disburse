import test from 'node:test';
import assert from 'node:assert/strict';
import { RenderedClipLayout } from '../db/schema.ts';
import {
  brandTemplateInputSchema,
  normalizeEnabledAspectRatios,
  normalizeEnabledLayouts,
} from './brand-template-validation.ts';

const baseTemplateInput = {
  name: 'Launch clips',
  aspectRatio: '9_16',
  defaultLayout: RenderedClipLayout.PRESERVE_ASPECT,
};

test('rejects empty enabled aspect ratios and enabled layouts', () => {
  assert.equal(
    brandTemplateInputSchema.safeParse({
      ...baseTemplateInput,
      enabledAspectRatios: [],
    }).success,
    false
  );
  assert.equal(
    brandTemplateInputSchema.safeParse({
      ...baseTemplateInput,
      enabledLayouts: [],
    }).success,
    false
  );
});

test('accepts source crop presets and rejects unknown crop presets', () => {
  for (const sourceCrop of ['original', '4_3', '1_1']) {
    assert.equal(
      brandTemplateInputSchema.safeParse({
        ...baseTemplateInput,
        cropSettings: { sourceCrop },
      }).success,
      true
    );
  }

  assert.equal(
    brandTemplateInputSchema.safeParse({
      ...baseTemplateInput,
      cropSettings: { sourceCrop: 'wide' },
    }).success,
    false
  );
});

test('accepts manual caption placement and normalizes caption placement coordinates', () => {
  const parsed = brandTemplateInputSchema.parse({
    ...baseTemplateInput,
    captionPosition: 'manual',
    cropSettings: {
      sourceCrop: 'original',
      captionPlacements: {
        '9_16': { x: 1.2, y: -0.2 },
        '1_1': { x: 0.5, y: 0.75 },
      },
    },
  });

  assert.equal(parsed.captionPosition, 'manual');
  assert.deepEqual(parsed.cropSettings.captionPlacements, {
    '9_16': { x: 1, y: 0 },
    '1_1': { x: 0.5, y: 0.75 },
  });
});

test('rejects invalid manual caption placement payloads', () => {
  assert.equal(
    brandTemplateInputSchema.safeParse({
      ...baseTemplateInput,
      captionPosition: 'manual',
      cropSettings: {
        sourceCrop: 'original',
        captionPlacements: {
          '16_9': { x: '0.5', y: 0.8 },
        },
      },
    }).success,
    false
  );
});

test('supports fit and fill layout values', () => {
  const parsed = brandTemplateInputSchema.parse({
    ...baseTemplateInput,
    enabledLayouts: [
      RenderedClipLayout.PRESERVE_ASPECT,
      RenderedClipLayout.DEFAULT,
    ],
  });

  assert.deepEqual(parsed.enabledLayouts, [
    RenderedClipLayout.PRESERVE_ASPECT,
    RenderedClipLayout.DEFAULT,
  ]);
});

test('normalizes enabled selections by including defaults and removing duplicates', () => {
  assert.deepEqual(
    normalizeEnabledAspectRatios(['16_9', '9_16', '16_9'], '1_1'),
    ['1_1', '16_9', '9_16']
  );
  assert.deepEqual(
    normalizeEnabledLayouts(
      [
        RenderedClipLayout.DEFAULT,
        RenderedClipLayout.FACECAM_TOP_50,
        RenderedClipLayout.DEFAULT,
      ],
      RenderedClipLayout.PRESERVE_ASPECT
    ),
    [
      RenderedClipLayout.PRESERVE_ASPECT,
      RenderedClipLayout.DEFAULT,
      RenderedClipLayout.FACECAM_TOP_50,
    ]
  );
});

test('keeps only one split layout when normalizing enabled layouts', () => {
  assert.deepEqual(
    normalizeEnabledLayouts(
      [
        RenderedClipLayout.DEFAULT,
        RenderedClipLayout.FACECAM_TOP_40,
        RenderedClipLayout.FACECAM_TOP_30,
      ],
      RenderedClipLayout.PRESERVE_ASPECT
    ),
    [
      RenderedClipLayout.PRESERVE_ASPECT,
      RenderedClipLayout.DEFAULT,
      RenderedClipLayout.FACECAM_TOP_40,
    ]
  );

  assert.deepEqual(
    normalizeEnabledLayouts(
      [
        RenderedClipLayout.DEFAULT,
        RenderedClipLayout.FACECAM_TOP_50,
      ],
      RenderedClipLayout.FACECAM_TOP_30
    ),
    [RenderedClipLayout.FACECAM_TOP_30, RenderedClipLayout.DEFAULT]
  );
});
