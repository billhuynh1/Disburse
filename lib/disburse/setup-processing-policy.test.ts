import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SourceAssetType,
  TranscriptStatus,
} from '../db/schema.ts';
import { shouldEnqueueTranscriptionFromSetup } from './setup-processing-policy.ts';

test('setup enqueues transcription for uploaded media without a ready transcript', () => {
  assert.equal(
    shouldEnqueueTranscriptionFromSetup({
      assetType: SourceAssetType.UPLOADED_FILE,
      transcript: null,
    }),
    true
  );
  assert.equal(
    shouldEnqueueTranscriptionFromSetup({
      assetType: SourceAssetType.UPLOADED_FILE,
      transcript: { status: TranscriptStatus.PENDING },
    }),
    true
  );
  assert.equal(
    shouldEnqueueTranscriptionFromSetup({
      assetType: SourceAssetType.UPLOADED_FILE,
      transcript: { status: TranscriptStatus.FAILED },
    }),
    true
  );
});

test('setup skips transcription when uploaded transcript is already ready', () => {
  assert.equal(
    shouldEnqueueTranscriptionFromSetup({
      assetType: SourceAssetType.UPLOADED_FILE,
      transcript: { status: TranscriptStatus.READY },
    }),
    false
  );
});

test('setup does not enqueue upload transcription for non-upload sources', () => {
  assert.equal(
    shouldEnqueueTranscriptionFromSetup({
      assetType: SourceAssetType.YOUTUBE_URL,
      transcript: null,
    }),
    false
  );
  assert.equal(
    shouldEnqueueTranscriptionFromSetup({
      assetType: SourceAssetType.PASTED_TRANSCRIPT,
      transcript: { status: TranscriptStatus.READY },
    }),
    false
  );
});
