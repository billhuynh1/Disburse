import assert from 'node:assert/strict';
import test from 'node:test';
import { validateClipTiming } from './clip-timing.ts';

test('accepts valid clip timing', () => {
  assert.deepEqual(
    validateClipTiming({
      startTimeMs: 1_000,
      endTimeMs: 6_000,
      durationMs: 5_000,
    }),
    {
      startTimeMs: 1_000,
      endTimeMs: 6_000,
      durationMs: 5_000,
    }
  );
});

test('rejects invalid timing instead of normalizing to zero', () => {
  assert.throws(
    () =>
      validateClipTiming({
        startTimeMs: Number.NaN,
        endTimeMs: 5_000,
      }),
    /invalid start time/
  );

  assert.throws(
    () =>
      validateClipTiming({
        startTimeMs: 0,
        endTimeMs: 0,
      }),
    /invalid end time/
  );

  assert.throws(
    () =>
      validateClipTiming({
        startTimeMs: 1_000,
        endTimeMs: 5_000,
        durationMs: 3_000,
      }),
    /invalid duration/
  );
});
