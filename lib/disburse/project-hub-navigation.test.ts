import assert from 'node:assert/strict';
import test from 'node:test';
import { hasReadyCurrentSnapshotClip } from './project-hub-navigation.ts';

function pack() {
  return {
    kind: 'short_form_clips',
    sourceAssetId: 1,
    shortFormGenerationMode: 'snapshot',
    generationRunId: 'current',
    clipCandidates: [1, 2].map((id) => ({
      id,
      generationRunId: 'current',
      currentRenderConfigId: id * 10 as number | null,
      renderedClips: [{
        clipCandidateId: id,
        clipRenderConfigId: id * 10 as number | null,
        generationRunId: 'current',
        status: 'rendering',
      }],
    })),
  };
}

test('a current READY snapshot clip unlocks access while its sibling renders or fails', () => {
  const current = pack();
  assert.equal(hasReadyCurrentSnapshotClip([current], 1), false);
  current.clipCandidates[0].renderedClips[0].status = 'ready';
  assert.equal(hasReadyCurrentSnapshotClip([current], 1), true);
  current.clipCandidates[1].renderedClips[0].status = 'failed';
  assert.equal(hasReadyCurrentSnapshotClip([current], 1), true);
});

test('pending, rendering, failed, and missing artifacts keep access gated', () => {
  for (const status of ['pending', 'rendering', 'failed']) {
    const current = pack();
    current.clipCandidates.forEach((candidate) => {
      candidate.renderedClips[0].status = status;
    });
    assert.equal(hasReadyCurrentSnapshotClip([current], 1), false);
  }
  const current = pack();
  current.clipCandidates.forEach((candidate) => { candidate.renderedClips = []; });
  assert.equal(hasReadyCurrentSnapshotClip([current], 1), false);
});

test('historical artifacts and candidates cannot unlock the current generation', () => {
  for (const mismatch of ['candidateRun', 'artifactRun', 'config', 'candidateId', 'noPointer']) {
    const current = pack();
    const candidate = current.clipCandidates[0];
    const artifact = candidate.renderedClips[0];
    artifact.status = 'ready';
    if (mismatch === 'candidateRun') candidate.generationRunId = 'historical';
    if (mismatch === 'artifactRun') artifact.generationRunId = 'historical';
    if (mismatch === 'config') artifact.clipRenderConfigId = 99;
    if (mismatch === 'candidateId') artifact.clipCandidateId = 99;
    if (mismatch === 'noPointer') candidate.currentRenderConfigId = null;
    assert.equal(hasReadyCurrentSnapshotClip([current], 1), false, mismatch);
  }
});

test('legacy and absent generation identity preserve the existing navigation gate', () => {
  const current = pack();
  current.clipCandidates[0].renderedClips[0].status = 'ready';
  current.shortFormGenerationMode = 'legacy';
  assert.equal(hasReadyCurrentSnapshotClip([current], 1), false);
  current.shortFormGenerationMode = 'snapshot';
  current.generationRunId = '';
  assert.equal(hasReadyCurrentSnapshotClip([current], 1), false);
  assert.equal(hasReadyCurrentSnapshotClip([], 1), false);
});

test('only the selected source pack can unlock access when multiple sources exist', () => {
  const current = pack();
  const other = pack();
  other.sourceAssetId = 2;
  other.clipCandidates[0].renderedClips[0].status = 'ready';
  assert.equal(hasReadyCurrentSnapshotClip([other, current], 1), false);
  assert.equal(hasReadyCurrentSnapshotClip([other, current], 2), true);
  assert.equal(hasReadyCurrentSnapshotClip([other], 1), false);
});
