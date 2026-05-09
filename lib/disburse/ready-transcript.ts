export type ReadyTranscriptSegmentLike = {
  sequence: number;
  startTimeMs: number;
  endTimeMs: number;
  text: string;
};

export type ReadyTranscriptWordLike = {
  sequence: number;
  startTimeMs: number;
  endTimeMs: number;
  text: string;
};

export function normalizeReadyTranscriptInput(params: {
  content: string;
  segments: ReadyTranscriptSegmentLike[];
  words?: ReadyTranscriptWordLike[];
}) {
  const content = params.content.trim();
  const segments = params.segments
    .map((segment, index) => ({
      sequence: index,
      startTimeMs: segment.startTimeMs,
      endTimeMs: segment.endTimeMs,
      text: segment.text.trim(),
    }))
    .filter(
      (segment) =>
        segment.text.length > 0 && segment.endTimeMs > segment.startTimeMs
    );
  const words = (params.words || [])
    .map((word, index) => ({
      sequence: index,
      startTimeMs: word.startTimeMs,
      endTimeMs: word.endTimeMs,
      text: word.text.trim(),
    }))
    .filter((word) => word.text.length > 0 && word.endTimeMs > word.startTimeMs);

  if (content.length === 0 || segments.length === 0) {
    throw new Error(
      'Ready transcript requires non-empty content and timestamped segments.'
    );
  }

  return {
    content,
    segments,
    words,
  };
}
