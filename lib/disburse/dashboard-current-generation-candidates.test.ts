import assert from 'node:assert/strict';
import test from 'node:test';
import { ContentPackKind } from '../db/schema.ts';
import { getCurrentGenerationCandidatesForSelectedPack } from '../../app/(dashboard)/dashboard/current-generation-candidates.ts';

function shortFormPack(overrides: Record<string, unknown> = {}) {
  return {
    kind: ContentPackKind.SHORT_FORM_CLIPS,
    sourceAssetId: 1,
    generationRunId: 'run-1',
    clipCandidates: [],
    ...overrides,
  };
}

test('counts only candidates from the selected pack current generation', () => {
  const candidates = getCurrentGenerationCandidatesForSelectedPack(
    [
      shortFormPack({
        clipCandidates: [
          { generationRunId: 'run-1', reviewStatus: 'approved' },
          { generationRunId: 'run-1', reviewStatus: 'pending' },
          { generationRunId: 'old-run', reviewStatus: 'approved' },
          { generationRunId: null, reviewStatus: 'approved' },
        ],
      }),
    ],
    1,
  );

  assert.equal(candidates.length, 2);
  assert.equal(
    candidates.filter((candidate) => candidate.reviewStatus === 'approved').length,
    1,
  );
});

test('excludes candidates from another short-form pack', () => {
  const candidates = getCurrentGenerationCandidatesForSelectedPack(
    [
      shortFormPack({
        clipCandidates: [{ generationRunId: 'run-1', reviewStatus: 'pending' }],
      }),
      shortFormPack({
        sourceAssetId: 2,
        generationRunId: 'run-2',
        clipCandidates: [{ generationRunId: 'run-2', reviewStatus: 'approved' }],
      }),
    ],
    1,
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].reviewStatus, 'pending');
});

test('returns no candidates when there is no selected short-form pack', () => {
  const candidates = getCurrentGenerationCandidatesForSelectedPack([], 1);

  assert.deepEqual(candidates, []);
});
