import assert from 'node:assert/strict';
import test from 'node:test';
import { TranscriptStatus } from '../db/schema.ts';

function shouldEnqueueTranscriptionForTranscriptStatus(
  status: string | null | undefined
) {
  return status !== TranscriptStatus.READY;
}

test('does not enqueue a new transcription job when the transcript is already ready', () => {
  assert.equal(
    shouldEnqueueTranscriptionForTranscriptStatus(TranscriptStatus.READY),
    false
  );
});

test('still allows enqueueing when the transcript is pending, processing, missing, or failed', () => {
  assert.equal(
    shouldEnqueueTranscriptionForTranscriptStatus(TranscriptStatus.PENDING),
    true
  );
  assert.equal(
    shouldEnqueueTranscriptionForTranscriptStatus(TranscriptStatus.PROCESSING),
    true
  );
  assert.equal(
    shouldEnqueueTranscriptionForTranscriptStatus(TranscriptStatus.FAILED),
    true
  );
  assert.equal(shouldEnqueueTranscriptionForTranscriptStatus(undefined), true);
  assert.equal(shouldEnqueueTranscriptionForTranscriptStatus(null), true);
});
