import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getProjectClipPresentationState,
  projectRenderedClip
} from './project-rendered-clip-projection.ts';

type RenderedClip = {
  id: number;
  clipRenderConfigId: number | null;
  generationRunId: string;
  variant: string;
  layout: string;
  editConfigHash: string | null;
  status: string;
};
type RenderConfig = { id: number; layout: string; renderedClips: RenderedClip[] };

function clip(id: number, clipRenderConfigId: number | null, layout = 'default'): RenderedClip {
  return {
    id,
    clipRenderConfigId,
    generationRunId: 'snapshot-run',
    variant: 'vertical_short_form',
    layout,
    editConfigHash: null,
    status: 'ready',
  };
}

function snapshotProjection(
  currentRenderConfigId: number | null,
  currentRenderConfig: RenderConfig | null,
  historicalRenderedClips: RenderedClip[] = []
) {
  return projectRenderedClip({ candidate: { id: 1, generationRunId: 'snapshot-run', currentRenderConfigId }, editConfig: { aspectRatio: '9_16', layout: 'default', configHash: 'snapshot-test' }, generationMode: 'snapshot' as const, currentRenderConfig, legacyRenderedClips: historicalRenderedClips });
}

test('snapshot current pointer wins over a ready historical artifact', () => {
  const historical = clip(10, 1);
  const current = clip(11, 2);
  const projection = snapshotProjection(2, { id: 2, layout: 'default', renderedClips: [historical, current] }, [historical]);
  assert.equal(projection.effectiveRenderConfig?.id, 2);
  assert.equal(projection.renderedClip?.id, 11);
  assert.notEqual(projection.renderedClip?.id, historical.id);
});

test('snapshot current pending config does not fall back to historical ready output', () => {
  const historical = clip(10, 1);
  const projection = snapshotProjection(2, { id: 2, layout: 'default', renderedClips: [] }, [historical]);
  assert.equal(projection.effectiveRenderConfig?.id, 2);
  assert.equal(projection.renderedClip, null);
});

test('snapshot uses the current config ID when historical and current layouts match', () => {
  const historical = clip(10, 1);
  const current = clip(11, 2);
  assert.equal(snapshotProjection(2, { id: 2, layout: 'default', renderedClips: [historical, current] }, [historical]).renderedClip?.clipRenderConfigId, 2);
});

test('snapshot with no pointer has no authoritative config or artifact', () => {
  const historical = clip(10, 1);
  const projection = snapshotProjection(null, null, [historical]);
  assert.equal(projection.effectiveRenderConfig, null);
  assert.equal(projection.renderedClip, null);
  assert.equal(getProjectClipPresentationState({ generationMode: 'snapshot', currentRenderConfigId: null, effectiveRenderConfig: projection.effectiveRenderConfig, renderedClip: projection.renderedClip }), 'preparing');
});

test('snapshot exposes one current facecam output', () => {
  const current = clip(12, 3, 'facecam_top_30');
  const projection = snapshotProjection(3, { id: 3, layout: 'facecam_top_30', renderedClips: [current] });
  assert.equal(projection.effectiveRenderConfig?.layout, 'facecam_top_30');
  assert.equal(projection.renderedClip?.id, 12);
});

test('snapshot exposes one current fallback output', () => {
  const current = clip(13, 4);
  assert.equal(snapshotProjection(4, { id: 4, layout: 'default', renderedClips: [current] }).renderedClip?.id, 13);
});

test('legacy retains Phase B variant, layout, and config-hash selection across sibling outputs', () => {
  const legacyRenderedClips: RenderedClip[] = [
    { id: 0, clipRenderConfigId: null, generationRunId: 'legacy-historical', variant: 'square_short_form', layout: 'default', editConfigHash: 'current', status: 'ready' },
    { id: 1, clipRenderConfigId: null, generationRunId: 'legacy-current', variant: 'vertical_short_form', layout: 'default', editConfigHash: 'stale', status: 'ready' },
    { id: 2, clipRenderConfigId: null, generationRunId: 'legacy-current', variant: 'square_short_form', layout: 'default', editConfigHash: 'current', status: 'ready' },
    { id: 3, clipRenderConfigId: null, generationRunId: 'legacy-current', variant: 'vertical_short_form', layout: 'preserve_aspect', editConfigHash: 'current', status: 'ready' },
  ];
  const projection = projectRenderedClip({
    candidate: { id: 1, generationRunId: 'legacy-current', currentRenderConfigId: null },
    editConfig: { aspectRatio: '1_1', layout: 'default', configHash: 'current' },
    generationMode: 'legacy' as const,
    currentRenderConfig: null,
    legacyRenderedClips,
  });
  assert.equal(projection.effectiveRenderConfig, null);
  assert.equal(projection.renderedClip?.id, 2);
});

test('legacy projects a ready config-backed fallback artifact despite its distinct render-config hash', () => {
  const projection = projectRenderedClip({
    candidate: { id: 8, generationRunId: 'legacy-smoke-run', currentRenderConfigId: null },
    editConfig: { aspectRatio: '9_16', layout: 'default', configHash: 'fallback-config' },
    generationMode: 'legacy',
    currentRenderConfig: null,
    legacyRenderedClips: [
      {
        id: 13,
        clipRenderConfigId: 20,
        generationRunId: 'legacy-smoke-run',
        variant: 'vertical_short_form',
        layout: 'default',
        editConfigHash: 'render-config-hash',
        status: 'ready',
      },
    ],
  });

  assert.equal(projection.renderedClip?.id, 13);
});

test('legacy projects the ready config-backed artifact when its preserved facecam layout agrees', () => {
  const projection = projectRenderedClip({
    candidate: { id: 10, generationRunId: 'legacy-facecam-run', currentRenderConfigId: null },
    editConfig: { aspectRatio: '9_16', layout: 'facecam_top_30', configHash: 'edit-config-hash' },
    generationMode: 'legacy',
    currentRenderConfig: null,
    legacyRenderedClips: [
      {
        id: 15,
        clipRenderConfigId: 27,
        generationRunId: 'legacy-facecam-run',
        variant: 'vertical_short_form',
        layout: 'facecam_top_30',
        editConfigHash: 'render-config-hash',
        status: 'ready',
      },
    ],
  });

  assert.equal(projection.renderedClip?.id, 15);
});

test('legacy retains compatible ready sibling fallback when config-backed artifacts are present', () => {
  const projection = projectRenderedClip({
    candidate: { id: 1, generationRunId: 'legacy-current', currentRenderConfigId: null },
    editConfig: { aspectRatio: '9_16', layout: 'default', configHash: 'current' },
    generationMode: 'legacy',
    currentRenderConfig: null,
    legacyRenderedClips: [
      {
        id: 1,
        clipRenderConfigId: 20,
        generationRunId: 'legacy-current',
        variant: 'vertical_short_form',
        layout: 'default',
        editConfigHash: 'current',
        status: 'pending',
      },
      {
        id: 2,
        clipRenderConfigId: null,
        generationRunId: 'legacy-current',
        variant: 'square_short_form',
        layout: 'default',
        editConfigHash: 'current',
        status: 'ready',
      },
    ],
  });

  assert.equal(projection.renderedClip?.id, 2);
});

test('legacy only falls back to its current-generation trimmed original', () => {
  const projection = projectRenderedClip({
    candidate: { id: 1, generationRunId: 'legacy-current', currentRenderConfigId: null },
    editConfig: { aspectRatio: '9_16', layout: 'default', configHash: 'current' },
    generationMode: 'legacy' as const,
    currentRenderConfig: null,
    legacyRenderedClips: [
      { id: 1, clipRenderConfigId: null, generationRunId: 'legacy-historical', variant: 'trimmed_original', layout: 'default', editConfigHash: null, status: 'ready' },
      { id: 2, clipRenderConfigId: null, generationRunId: 'legacy-current', variant: 'trimmed_original', layout: 'default', editConfigHash: null, status: 'ready' },
    ],
  });

  assert.equal(projection.renderedClip?.id, 2);
});

test('legacy falls back from a non-ready exact artifact to a ready compatible sibling in the same generation', () => {
  const projection = projectRenderedClip({
    candidate: { id: 1, generationRunId: 'G2', currentRenderConfigId: null },
    editConfig: { aspectRatio: '9_16', layout: 'default', configHash: 'current' },
    generationMode: 'legacy',
    currentRenderConfig: null,
    legacyRenderedClips: [
      { id: 1, clipRenderConfigId: null, generationRunId: 'G1', variant: 'vertical_short_form', layout: 'default', editConfigHash: 'current', status: 'ready' },
      { id: 2, clipRenderConfigId: null, generationRunId: 'G2', variant: 'vertical_short_form', layout: 'default', editConfigHash: 'current', status: 'pending' },
      { id: 3, clipRenderConfigId: null, generationRunId: 'G2', variant: 'square_short_form', layout: 'default', editConfigHash: 'current', status: 'ready' },
    ],
  });

  assert.equal(projection.renderedClip?.id, 3);
});
