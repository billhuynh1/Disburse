import type { TimestampedTranscriptSegment } from './openai-transcription.ts';

export type YoutubeTranscriptJson3 = {
  events?: Array<{
    tStartMs?: number;
    dDurationMs?: number;
    segs?: Array<{
      utf8?: string;
    }>;
  }>;
};

export function normalizeTranscriptSegments(
  transcript: YoutubeTranscriptJson3
): TimestampedTranscriptSegment[] {
  return (transcript.events || [])
    .map((event, index) => {
      const text = (event.segs || [])
        .map((segment) => segment.utf8 || '')
        .join('')
        .replace(/\s+/g, ' ')
        .trim();

      if (!text) {
        return null;
      }

      if (
        !Number.isInteger(event.tStartMs) ||
        !Number.isInteger(event.dDurationMs)
      ) {
        throw new Error('YouTube transcript event is missing timestamp metadata.');
      }

      const startTimeMs = event.tStartMs!;
      const durationMs = event.dDurationMs!;
      const endTimeMs = startTimeMs + durationMs;

      return {
        sequence: index,
        startTimeMs,
        endTimeMs,
        text,
      };
    })
    .filter((segment): segment is TimestampedTranscriptSegment =>
      Boolean(segment && segment.endTimeMs > segment.startTimeMs)
    );
}
