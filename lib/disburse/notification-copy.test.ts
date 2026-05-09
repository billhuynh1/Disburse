import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NOTIFICATION_OUTCOME,
  NOTIFICATION_TYPE,
  buildNotificationDedupeKey,
  buildClipPublicationPublishedNotificationCopy,
  buildFacecamNotFoundNotificationCopy,
  buildRenderedClipReadyNotificationCopy,
  buildShortFormPackFailedNotificationCopy,
  buildTranscriptReadyNotificationCopy,
} from './notification-copy.ts';

test('builds transcript ready notifications with shared copy', () => {
  const notification = buildTranscriptReadyNotificationCopy('Episode 42');

  assert.equal(notification.type, NOTIFICATION_TYPE.TRANSCRIPT);
  assert.equal(notification.outcome, NOTIFICATION_OUTCOME.SUCCESS);
  assert.equal(notification.title, 'Transcript ready');
  assert.match(notification.message, /Episode 42/);
});

test('marks facecam not found as a warning notification', () => {
  const notification = buildFacecamNotFoundNotificationCopy('Intro clip');

  assert.equal(notification.type, NOTIFICATION_TYPE.FACECAM_DETECTION);
  assert.equal(notification.outcome, NOTIFICATION_OUTCOME.WARNING);
  assert.equal(notification.title, 'No facecam detected');
});

test('labels vertical rendered clips consistently', () => {
  const notification = buildRenderedClipReadyNotificationCopy({
    clipTitle: 'Opening hook',
    variant: 'vertical_short_form',
  });

  assert.equal(notification.type, NOTIFICATION_TYPE.RENDERED_CLIP);
  assert.equal(notification.title, 'Vertical clip ready');
  assert.match(notification.message, /Opening hook/);
});

test('uses failure copy for short-form generation failures', () => {
  const notification = buildShortFormPackFailedNotificationCopy(
    'Episode 42 Short Clips',
    null
  );

  assert.equal(notification.type, NOTIFICATION_TYPE.SHORT_FORM_PACK);
  assert.equal(notification.outcome, NOTIFICATION_OUTCOME.FAILURE);
  assert.match(notification.message, /Episode 42 Short Clips/);
});

test('formats clip publication notifications with platform names', () => {
  const notification = buildClipPublicationPublishedNotificationCopy({
    clipTitle: 'Launch teaser',
    platform: 'youtube',
  });

  assert.equal(notification.type, NOTIFICATION_TYPE.CLIP_PUBLICATION);
  assert.equal(notification.outcome, NOTIFICATION_OUTCOME.SUCCESS);
  assert.match(notification.message, /YouTube/);
});

test('builds deterministic notification dedupe keys from event identity', () => {
  const eventAt = new Date('2026-05-07T12:00:00.000Z');
  const left = buildNotificationDedupeKey({
    type: NOTIFICATION_TYPE.TRANSCRIPT,
    entityId: 9,
    status: NOTIFICATION_OUTCOME.SUCCESS,
    eventAt,
  });
  const right = buildNotificationDedupeKey({
    type: NOTIFICATION_TYPE.TRANSCRIPT,
    entityId: 9,
    status: NOTIFICATION_OUTCOME.SUCCESS,
    eventAt,
  });

  assert.equal(left, right);
  assert.equal(left, 'transcript:9:success:2026-05-07T12:00:00.000Z');
});
