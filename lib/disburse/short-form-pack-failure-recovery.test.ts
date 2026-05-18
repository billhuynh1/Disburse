import assert from 'node:assert/strict';
import test from 'node:test';
import { ContentPackStatus, SourceAssetType } from '../db/schema.ts';
import { getRecoverableShortFormPackStatus } from './short-form-pack-recovery.ts';

test('keeps uploaded short-form packs generating when current-run artifacts exist and processing is active', () => {
  assert.equal(
    getRecoverableShortFormPackStatus({
      sourceAssetType: SourceAssetType.UPLOADED_FILE,
      currentGenerationCandidateCount: 5,
      hasActiveProcessing: true,
    }),
    ContentPackStatus.GENERATING
  );
});

test('marks non-uploaded packs ready when current-run candidates already exist', () => {
  assert.equal(
    getRecoverableShortFormPackStatus({
      sourceAssetType: SourceAssetType.YOUTUBE_URL,
      currentGenerationCandidateCount: 3,
      hasActiveProcessing: false,
    }),
    ContentPackStatus.READY
  );
});

test('allows failure when no current-run artifacts or active recovery path exists', () => {
  assert.equal(
    getRecoverableShortFormPackStatus({
      sourceAssetType: SourceAssetType.UPLOADED_FILE,
      currentGenerationCandidateCount: 0,
      hasActiveProcessing: true,
    }),
    null
  );
  assert.equal(
    getRecoverableShortFormPackStatus({
      sourceAssetType: SourceAssetType.UPLOADED_FILE,
      currentGenerationCandidateCount: 4,
      hasActiveProcessing: false,
    }),
    null
  );
});
