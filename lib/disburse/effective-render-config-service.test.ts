import assert from 'node:assert/strict';
import test from 'node:test';

import { buildEffectiveRenderConfigHash } from './effective-render-config-service.ts';

test('effective render config hash is canonical and distinguishes terminal facecam outcomes', () => {
  const shared = {
    generationRunId: 'run-a',
    candidate: { id: 1, startTimeMs: 1000, endTimeMs: 5000, durationMs: 4000 },
    aspectRatio: '9_16',
    layout: 'default',
    cropSettings: { captionPlacements: { '9_16': { y: 0.4, x: 0.5 } }, sourceCrop: 'original' },
    facecamDetectionId: null,
  };
  const reordered = {
    facecamDetectionId: null,
    cropSettings: { sourceCrop: 'original', captionPlacements: { '9_16': { x: 0.5, y: 0.4 } } },
    layout: 'default',
    aspectRatio: '9_16',
    candidate: { durationMs: 4000, endTimeMs: 5000, startTimeMs: 1000, id: 1 },
    generationRunId: 'run-a',
  };

  assert.equal(buildEffectiveRenderConfigHash(shared), buildEffectiveRenderConfigHash(reordered));
  assert.notEqual(
    buildEffectiveRenderConfigHash(shared),
    buildEffectiveRenderConfigHash({ ...shared, layout: 'facecam_top_30', facecamDetectionId: 9 })
  );
});

test('snapshot-backed resolver never derives a layout or aspect-ratio Cartesian product', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./effective-render-config-service.ts', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /enabledLayouts|enabledAspectRatios|for \(const layout|for \(const aspectRatio/);
  assert.match(source, /snapshot\.facecam\.preferredLayout/);
  assert.match(source, /snapshot\.facecam\.fallbackLayout/);
  assert.match(source, /currentRenderConfigId: config\.id/);
});
