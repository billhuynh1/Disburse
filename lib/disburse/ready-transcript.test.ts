import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeReadyTranscriptInput } from './ready-transcript.ts';

test('rejects ready transcripts without content or timestamped segments', () => {
  assert.throws(
    () =>
      normalizeReadyTranscriptInput({
        content: '   ',
        segments: [],
      }),
    /Ready transcript requires non-empty content and timestamped segments\./
  );
});

test('normalizes and re-sequences ready transcript segments and words', () => {
  const transcript = normalizeReadyTranscriptInput({
    content: '  Transcript body  ',
    segments: [
      { sequence: 9, startTimeMs: 0, endTimeMs: 0, text: 'skip me' },
      { sequence: 3, startTimeMs: 10, endTimeMs: 40, text: ' first line ' },
      { sequence: 7, startTimeMs: 50, endTimeMs: 90, text: 'second line' },
    ],
    words: [
      { sequence: 3, startTimeMs: 10, endTimeMs: 20, text: ' first ' },
      { sequence: 4, startTimeMs: 25, endTimeMs: 25, text: 'skip' },
      { sequence: 8, startTimeMs: 30, endTimeMs: 40, text: 'line' },
    ],
  });

  assert.equal(transcript.content, 'Transcript body');
  assert.deepEqual(transcript.segments, [
    { sequence: 1, startTimeMs: 10, endTimeMs: 40, text: 'first line' },
    { sequence: 2, startTimeMs: 50, endTimeMs: 90, text: 'second line' },
  ]);
  assert.deepEqual(transcript.words, [
    { sequence: 0, startTimeMs: 10, endTimeMs: 20, text: 'first' },
    { sequence: 2, startTimeMs: 30, endTimeMs: 40, text: 'line' },
  ]);
});
