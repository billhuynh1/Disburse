import assert from 'node:assert/strict';
import test from 'node:test';
import { assertDirectPublishingProhibited, DirectPublishingProhibitedError } from './publishing-prohibition.ts';

test('direct publishing prohibition always fails closed before provider work', () => {
  assert.throws(() => assertDirectPublishingProhibited(), (error) =>
    error instanceof DirectPublishingProhibitedError && error.code === 'direct_publishing_prohibited'
  );
});
