import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { SourceAssetType } from '../db/schema.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

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

test('stalled empty uploaded packs get one first-run recovery retry', () => {
  const jobService = readFileSync(
    join(repoRoot, 'lib/disburse/job-service.ts'),
    'utf8'
  );

  assert.match(jobService, /countCompletedShortFormJobs/);
  assert.match(jobService, /completedGenerateJobCount <= 1/);
  assert.match(jobService, /empty_pack_first_recovery/);
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
