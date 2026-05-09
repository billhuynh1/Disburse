import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FACECAM_DETECTION_STALE_FAILURE_REASON,
  FACECAM_DETECTION_STALE_MS,
  isStaleFacecamDetectionStartedAt,
} from './facecam-recovery.ts';

test('marks facecam processing timestamps older than the stale threshold as stale', () => {
  const now = new Date('2026-05-07T12:00:00.000Z');
  const staleStartedAt = new Date(now.getTime() - FACECAM_DETECTION_STALE_MS);
  const freshStartedAt = new Date(now.getTime() - FACECAM_DETECTION_STALE_MS + 1);

  assert.equal(isStaleFacecamDetectionStartedAt(staleStartedAt, now), true);
  assert.equal(isStaleFacecamDetectionStartedAt(freshStartedAt, now), false);
});

test('treats missing processing timestamps as not stale', () => {
  const now = new Date('2026-05-07T12:00:00.000Z');

  assert.equal(isStaleFacecamDetectionStartedAt(null, now), false);
  assert.equal(isStaleFacecamDetectionStartedAt(undefined, now), false);
});

test('uses explicit stale recovery copy for internal facecam job failures', () => {
  assert.match(FACECAM_DETECTION_STALE_FAILURE_REASON, /stalled/i);
  assert.match(FACECAM_DETECTION_STALE_FAILURE_REASON, /retried automatically/i);
});
