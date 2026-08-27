import assert from 'node:assert/strict';
import test from 'node:test';
import { getAssCaptionPreviewSemantics } from './caption-preview.ts';

const previewParams = {
  aspectRatio: '9_16' as const,
  position: 'bottom' as const,
  captionStyle: 'default' as const,
  captionText: 'One clear caption event',
  captionFontColor: '#102030',
  captionHighlightColor: '#f0c000',
  frameWidthPx: 320,
};

test('uses configured caption colours only when ASS highlighting is enabled', () => {
  assert.deepEqual(
    getAssCaptionPreviewSemantics({
      ...previewParams,
      captionHighlightEnabled: true,
    }),
    {
      placement: { x: 0.5, y: 0.82 },
      text: 'One clear caption event',
      transform: 'translate(-50%, 0)',
      fontSizePx: 58 * (320 / 1080),
      boxPaddingPx: 4 * (320 / 1080),
      maxWidthPercent: (936 / 1080) * 100,
      backgroundColor: '#f0c000',
      fontColor: '#102030',
      borderRadiusPx: 0,
    }
  );

  assert.equal(
    getAssCaptionPreviewSemantics({
      ...previewParams,
      captionHighlightEnabled: false,
    }).backgroundColor,
    undefined
  );
});

test('models ASS top, middle, and bottom anchor points', () => {
  assert.deepEqual(
    ['top', 'middle', 'bottom'].map((position) => {
      const preview = getAssCaptionPreviewSemantics({
        ...previewParams,
        position: position as 'top' | 'middle' | 'bottom',
        captionHighlightEnabled: true,
      });

      return [position, preview.placement, preview.transform];
    }),
    [
      ['top', { x: 0.5, y: 0.18 }, 'translate(-50%, -100%)'],
      ['middle', { x: 0.5, y: 0.5 }, 'translate(-50%, -50%)'],
      ['bottom', { x: 0.5, y: 0.82 }, 'translate(-50%, 0)'],
    ]
  );
});

test('models a single-word caption as one timed word event', () => {
  assert.equal(
    getAssCaptionPreviewSemantics({
      ...previewParams,
      captionStyle: 'single_word',
      captionText: 'One word at a time',
      captionHighlightEnabled: true,
    }).text,
    'One'
  );
});
