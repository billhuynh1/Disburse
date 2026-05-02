import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRenderedClipAssCaptions,
  buildRenderedClipCaptionEvents,
  escapeAssText,
} from './rendered-clip-captions.ts';

test('includes only transcript segments overlapping the clip', () => {
  const events = buildRenderedClipCaptionEvents({
    clipStartTimeMs: 10_000,
    clipDurationMs: 5_000,
    fallbackText: 'fallback',
    transcriptSegments: [
      { startTimeMs: 1_000, endTimeMs: 2_000, text: 'too early' },
      { startTimeMs: 10_500, endTimeMs: 12_000, text: 'inside' },
      { startTimeMs: 14_500, endTimeMs: 16_000, text: 'partly inside' },
      { startTimeMs: 16_000, endTimeMs: 17_000, text: 'too late' },
    ],
  });

  assert.deepEqual(
    events.map((event) => event.text),
    ['inside', 'partly inside']
  );
});

test('shifts caption timings relative to the rendered clip start', () => {
  const events = buildRenderedClipCaptionEvents({
    clipStartTimeMs: 10_000,
    clipDurationMs: 5_000,
    fallbackText: '',
    transcriptSegments: [
      { startTimeMs: 9_000, endTimeMs: 11_000, text: 'starts before clip' },
      { startTimeMs: 14_000, endTimeMs: 16_000, text: 'ends after clip' },
    ],
  });

  assert.deepEqual(events, [
    { startTimeMs: 0, endTimeMs: 700, text: 'starts before clip' },
    { startTimeMs: 4_000, endTimeMs: 4_700, text: 'ends after clip' },
  ]);
});

test('falls back to the transcript excerpt when no timed segment overlaps', () => {
  const events = buildRenderedClipCaptionEvents({
    clipStartTimeMs: 10_000,
    clipDurationMs: 5_000,
    fallbackText: 'Use this excerpt',
    transcriptSegments: [
      { startTimeMs: 1_000, endTimeMs: 2_000, text: 'too early' },
    ],
  });

  assert.deepEqual(
    events.map((event) => event.text),
    ['Use this excerpt']
  );
});

test('escapes ASS override characters safely', () => {
  assert.equal(
    escapeAssText(String.raw`Look {bold}\now`),
    String.raw`Look \{bold\}\\now`
  );
});

test('splits long transcript segments into short caption chunks', () => {
  const events = buildRenderedClipCaptionEvents({
    clipStartTimeMs: 0,
    clipDurationMs: 8_000,
    fallbackText: '',
    transcriptSegments: [
      {
        startTimeMs: 0,
        endTimeMs: 8_000,
        text: 'This longer caption should become short readable chunks for vertical video',
      },
    ],
  });

  assert.deepEqual(
    events.map((event) => event.text),
    ['This longer caption should', 'become short readable chunks', 'for vertical video']
  );
  assert.ok(events.every((event) => event.text.split(' ').length <= 4));
  assert.ok(events.every((event) => event.text.length <= 32));
});

test('uses word timestamps in max four-word caption groups', () => {
  const events = buildRenderedClipCaptionEvents({
    clipStartTimeMs: 10_000,
    clipDurationMs: 5_000,
    fallbackText: '',
    transcriptSegments: [
      { startTimeMs: 10_000, endTimeMs: 15_000, text: 'segment fallback text' },
    ],
    transcriptWords: [
      { startTimeMs: 10_100, endTimeMs: 10_250, text: 'one' },
      { startTimeMs: 10_300, endTimeMs: 10_450, text: 'two' },
      { startTimeMs: 10_500, endTimeMs: 10_650, text: 'three' },
      { startTimeMs: 10_700, endTimeMs: 10_850, text: 'four' },
      { startTimeMs: 10_900, endTimeMs: 11_050, text: 'five' },
    ],
  });

  assert.deepEqual(events, [
    { startTimeMs: 100, endTimeMs: 850, text: 'one two three four' },
    { startTimeMs: 900, endTimeMs: 1_050, text: 'five' },
  ]);
});

test('sets word caption boundaries from first and last word timestamps', () => {
  const events = buildRenderedClipCaptionEvents({
    clipStartTimeMs: 0,
    clipDurationMs: 5_000,
    fallbackText: '',
    transcriptSegments: [],
    transcriptWords: [
      { startTimeMs: 1_000, endTimeMs: 1_100, text: 'real' },
      { startTimeMs: 1_600, endTimeMs: 1_800, text: 'timing' },
    ],
  });

  assert.deepEqual(events, [
    { startTimeMs: 1_000, endTimeMs: 1_800, text: 'real timing' },
  ]);
});

test('clamps word-timed captions at render boundaries', () => {
  const events = buildRenderedClipCaptionEvents({
    clipStartTimeMs: 1_000,
    clipDurationMs: 1_000,
    fallbackText: '',
    transcriptSegments: [],
    transcriptWords: [
      { startTimeMs: 500, endTimeMs: 1_100, text: 'starts' },
      { startTimeMs: 1_200, endTimeMs: 2_500, text: 'ends' },
    ],
  });

  assert.deepEqual(events, [
    { startTimeMs: 0, endTimeMs: 1_000, text: 'starts ends' },
  ]);
});

test('chunks fallback text across the full clip duration', () => {
  const events = buildRenderedClipCaptionEvents({
    clipStartTimeMs: 10_000,
    clipDurationMs: 6_000,
    fallbackText:
      'Fallback captions should also use short chunks instead of one long subtitle',
    transcriptSegments: [],
  });

  assert.deepEqual(
    events.map((event) => event.text),
    ['Fallback captions should also', 'use short chunks instead', 'of one long subtitle']
  );
  assert.equal(events[0].startTimeMs, 0);
  assert.equal(events.at(-1)?.endTimeMs, 2_100);
  assert.ok(events.every((event) => event.text.split(' ').length <= 4));
});

test('does not stretch short chunks to fill a long segment', () => {
  const events = buildRenderedClipCaptionEvents({
    clipStartTimeMs: 0,
    clipDurationMs: 10_000,
    fallbackText: '',
    transcriptSegments: [
      {
        startTimeMs: 0,
        endTimeMs: 10_000,
        text: 'Short phrase',
      },
    ],
  });

  assert.deepEqual(events, [
    { startTimeMs: 0, endTimeMs: 700, text: 'Short phrase' },
  ]);
});

test('compresses chunk timing when many chunks must fit a short segment', () => {
  const events = buildRenderedClipCaptionEvents({
    clipStartTimeMs: 0,
    clipDurationMs: 1_000,
    fallbackText: '',
    transcriptSegments: [
      {
        startTimeMs: 0,
        endTimeMs: 1_000,
        text: 'one two three four five six seven eight nine ten eleven twelve',
      },
    ],
  });

  assert.deepEqual(
    events.map((event) => event.text),
    ['one two three four', 'five six seven eight', 'nine ten eleven twelve']
  );
  assert.equal(events.at(-1)?.endTimeMs, 999);
  assert.ok(events.every((event) => event.endTimeMs - event.startTimeMs <= 900));
});

test('clamps chunk timing at clip boundaries', () => {
  const events = buildRenderedClipCaptionEvents({
    clipStartTimeMs: 1_000,
    clipDurationMs: 1_000,
    fallbackText: '',
    transcriptSegments: [
      {
        startTimeMs: 500,
        endTimeMs: 1_500,
        text: 'starts before clip',
      },
      {
        startTimeMs: 1_500,
        endTimeMs: 2_500,
        text: 'ends after clip',
      },
    ],
  });

  assert.deepEqual(events, [
    { startTimeMs: 0, endTimeMs: 500, text: 'starts before clip' },
    { startTimeMs: 500, endTimeMs: 1_000, text: 'ends after clip' },
  ]);
});

test('builds ASS dialogue with shifted timestamps', () => {
  const captions = buildRenderedClipAssCaptions({
    clipStartTimeMs: 10_000,
    clipDurationMs: 5_000,
    fallbackText: '',
    transcriptSegments: [
      { startTimeMs: 10_500, endTimeMs: 12_250, text: 'caption text' },
    ],
  });

  assert.match(
    captions || '',
    /Dialogue: 0,0:00:00\.50,0:00:01\.20,Default,,0,0,0,,caption text/
  );
});
