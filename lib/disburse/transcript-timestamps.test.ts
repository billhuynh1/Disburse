import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSegmentsFromWords } from './transcript-timestamps.ts';

test('builds a transcript segment from contiguous word timestamps', () => {
  const segments = buildSegmentsFromWords([
    { startTimeMs: 0, endTimeMs: 400, text: 'hello' },
    { startTimeMs: 450, endTimeMs: 800, text: 'world' },
    { startTimeMs: 820, endTimeMs: 1100, text: 'again' },
  ]);

  assert.deepEqual(segments, [
    {
      sequence: 0,
      startTimeMs: 0,
      endTimeMs: 1100,
      text: 'hello world again',
    },
  ]);
});

test('splits synthesized transcript segments when there is a long pause between words', () => {
  const segments = buildSegmentsFromWords([
    { startTimeMs: 0, endTimeMs: 300, text: 'first' },
    { startTimeMs: 320, endTimeMs: 700, text: 'thought' },
    { startTimeMs: 2500, endTimeMs: 2800, text: 'second' },
    { startTimeMs: 2820, endTimeMs: 3200, text: 'thought' },
  ]);

  assert.deepEqual(segments, [
    {
      sequence: 0,
      startTimeMs: 0,
      endTimeMs: 700,
      text: 'first thought',
    },
    {
      sequence: 1,
      startTimeMs: 2500,
      endTimeMs: 3200,
      text: 'second thought',
    },
  ]);
});
