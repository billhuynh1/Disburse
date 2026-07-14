import assert from 'node:assert/strict';
import test from 'node:test';
import { SourceAssetType } from '../db/schema.ts';
import { decideGenerationReconciliation } from './pipeline-reconciliation-policy.ts';

function shouldRetryEmptyUploadedShortFormPack(params: {
  sourceAssetType: string;
  clipCandidateCount: number;
  hasCompletedGenerateJob: boolean;
  hasMissingCandidateCancellation: boolean;
}) {
  return (
    params.sourceAssetType === SourceAssetType.UPLOADED_FILE &&
    params.clipCandidateCount === 0 &&
    params.hasCompletedGenerateJob &&
    params.hasMissingCandidateCancellation
  );
}

test('retries empty uploaded packs when candidates previously disappeared mid-pipeline', () => {
  assert.equal(
    shouldRetryEmptyUploadedShortFormPack({
      sourceAssetType: SourceAssetType.UPLOADED_FILE,
      clipCandidateCount: 0,
      hasCompletedGenerateJob: true,
      hasMissingCandidateCancellation: true,
    }),
    true
  );
});

test('completed empty packs require cancellation evidence and consume one rebuild', () => {
  const observation = {
    projectDeleting: false,
    sourceDeleting: false,
    sourceDeleted: false,
    sourceExpired: false,
    mediaAvailable: true,
    currentGeneration: true,
    packStatus: 'generating' as const,
    transcriptReady: true,
    jobStatus: 'completed' as const,
    hasCurrentOutput: false,
    hasMissingCandidateCancellation: true,
    rebuildConsumed: false,
  };
  assert.equal(decideGenerationReconciliation(observation).action, 'rebuild');
  assert.equal(
    decideGenerationReconciliation({ ...observation, rebuildConsumed: true }).action,
    'terminalize'
  );
});

test('does not retry normal empty-pack outcomes without missing-candidate evidence', () => {
  assert.equal(
    shouldRetryEmptyUploadedShortFormPack({
      sourceAssetType: SourceAssetType.UPLOADED_FILE,
      clipCandidateCount: 0,
      hasCompletedGenerateJob: true,
      hasMissingCandidateCancellation: false,
    }),
    false
  );
});

test('does not retry when candidates still exist or the source type is not an uploaded video', () => {
  assert.equal(
    shouldRetryEmptyUploadedShortFormPack({
      sourceAssetType: SourceAssetType.UPLOADED_FILE,
      clipCandidateCount: 1,
      hasCompletedGenerateJob: true,
      hasMissingCandidateCancellation: true,
    }),
    false
  );
  assert.equal(
    shouldRetryEmptyUploadedShortFormPack({
      sourceAssetType: SourceAssetType.YOUTUBE_URL,
      clipCandidateCount: 0,
      hasCompletedGenerateJob: true,
      hasMissingCandidateCancellation: true,
    }),
    false
  );
});
