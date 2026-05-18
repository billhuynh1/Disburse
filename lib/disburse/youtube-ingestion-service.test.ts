import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTranscriptSegments } from './youtube-transcript-normalizer.ts';

test('normalizes YouTube transcript events with explicit timing', () => {
  assert.deepEqual(
    normalizeTranscriptSegments({
      events: [
        {
          tStartMs: 1_000,
          dDurationMs: 2_000,
          segs: [{ utf8: ' hello ' }, { utf8: 'world' }],
        },
      ],
    }),
    [
      {
        sequence: 0,
        startTimeMs: 1_000,
        endTimeMs: 3_000,
        text: 'hello world',
      },
    ]
  );
});

test('rejects YouTube transcript events that omit timing', () => {
  assert.throws(
    () =>
      normalizeTranscriptSegments({
        events: [
          {
            dDurationMs: 2_000,
            segs: [{ utf8: 'missing start should fail' }],
          },
        ],
      }),
    /missing timestamp metadata/
  );
});
