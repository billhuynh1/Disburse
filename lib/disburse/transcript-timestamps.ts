export type TimestampedTranscriptSegmentLike = {
  startTimeMs: number;
  endTimeMs: number;
  text: string;
};

export type TimestampedTranscriptWordLike = {
  startTimeMs: number;
  endTimeMs: number;
  text: string;
};

const MAX_SYNTHETIC_SEGMENT_DURATION_MS = 8000;
const MAX_SYNTHETIC_SEGMENT_WORDS = 36;
const SYNTHETIC_SEGMENT_GAP_MS = 1200;

export function buildSegmentsFromWords(
  words: TimestampedTranscriptWordLike[]
) {
  const segments: TimestampedTranscriptSegmentLike[] = [];
  let currentWords: TimestampedTranscriptWordLike[] = [];

  for (const word of words) {
    const firstWord = currentWords[0];
    const previousWord = currentWords[currentWords.length - 1];
    const startsNewSegment =
      currentWords.length > 0 &&
      previousWord &&
      firstWord &&
      (word.startTimeMs - previousWord.endTimeMs > SYNTHETIC_SEGMENT_GAP_MS ||
        word.endTimeMs - firstWord.startTimeMs >
          MAX_SYNTHETIC_SEGMENT_DURATION_MS ||
        currentWords.length >= MAX_SYNTHETIC_SEGMENT_WORDS);

    if (startsNewSegment) {
      segments.push({
        startTimeMs: currentWords[0].startTimeMs,
        endTimeMs: currentWords[currentWords.length - 1].endTimeMs,
        text: currentWords.map((item) => item.text).join(' '),
      });
      currentWords = [];
    }

    currentWords.push(word);
  }

  if (currentWords.length > 0) {
    segments.push({
      startTimeMs: currentWords[0].startTimeMs,
      endTimeMs: currentWords[currentWords.length - 1].endTimeMs,
      text: currentWords.map((item) => item.text).join(' '),
    });
  }

  return segments.map((segment, index) => ({
    sequence: index,
    ...segment,
  }));
}
