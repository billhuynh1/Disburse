export type CaptionTranscriptSegment = {
  startTimeMs: number;
  endTimeMs: number;
  text: string;
};

export type CaptionTranscriptWord = {
  startTimeMs: number;
  endTimeMs: number;
  text: string;
};

type RenderCaptionParams = {
  clipStartTimeMs: number;
  clipDurationMs: number;
  transcriptSegments: CaptionTranscriptSegment[];
  transcriptWords?: CaptionTranscriptWord[];
  fallbackText: string;
  fontFamily?: string | null;
};

function buildAssHeader(fontFamily?: string | null) {
  const fontName =
    normalizeCaptionText(fontFamily || '').replace(/,/g, ' ') || 'Arial';

  return `[Script Info]
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},58,&H00FFFFFF,&H00FFFFFF,&HCC000000,&H99000000,-1,0,0,0,100,100,0,0,1,4,2,2,72,72,180,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;
}
const MAX_CAPTION_WORD_COUNT = 4;
const MAX_CAPTION_CHARACTER_COUNT = 32;
const TARGET_CAPTION_DURATION_MS = 700;
const MIN_CAPTION_DURATION_MS = 350;
const MAX_CAPTION_DURATION_MS = 900;

function normalizeCaptionText(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

export function escapeAssText(text: string) {
  return normalizeCaptionText(text)
    .replace(/\\/g, '\\\\')
    .replace(/{/g, '\\{')
    .replace(/}/g, '\\}');
}

function splitOversizedWord(word: string) {
  if (word.length <= MAX_CAPTION_CHARACTER_COUNT) {
    return [word];
  }

  const chunks: string[] = [];

  for (let index = 0; index < word.length; index += MAX_CAPTION_CHARACTER_COUNT) {
    chunks.push(word.slice(index, index + MAX_CAPTION_CHARACTER_COUNT));
  }

  return chunks;
}

function splitCaptionTextIntoChunks(text: string) {
  const words = normalizeCaptionText(text)
    .split(' ')
    .filter(Boolean)
    .flatMap(splitOversizedWord);
  const chunks: string[][] = [];
  let currentChunk: string[] = [];

  for (const word of words) {
    const nextChunk = [...currentChunk, word];
    const nextChunkText = nextChunk.join(' ');

    if (
      nextChunk.length <= MAX_CAPTION_WORD_COUNT &&
      nextChunkText.length <= MAX_CAPTION_CHARACTER_COUNT
    ) {
      currentChunk = nextChunk;
      continue;
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }

    currentChunk = [word];
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks.map((chunk) => ({
    text: chunk.join(' '),
    wordCount: chunk.length,
  }));
}

function formatAssTimestamp(totalMs: number) {
  const normalizedMs = Math.max(0, Math.round(totalMs));
  const centiseconds = Math.floor((normalizedMs % 1000) / 10);
  const totalSeconds = Math.floor(normalizedMs / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
}

export function buildRenderedClipCaptionEvents(params: RenderCaptionParams) {
  const clipStartTimeMs = Math.max(0, params.clipStartTimeMs);
  const clipDurationMs = Math.max(0, params.clipDurationMs);
  const clipEndTimeMs = clipStartTimeMs + clipDurationMs;

  const wordEvents = buildWordTimedCaptionEvents({
    clipStartTimeMs,
    clipDurationMs,
    clipEndTimeMs,
    transcriptWords: params.transcriptWords || [],
  });

  if (wordEvents.length > 0) {
    return wordEvents;
  }

  const events = [...params.transcriptSegments]
    .sort((left, right) => left.startTimeMs - right.startTimeMs)
    .filter(
      (segment) =>
        normalizeCaptionText(segment.text).length > 0 &&
        segment.startTimeMs < clipEndTimeMs &&
        segment.endTimeMs > clipStartTimeMs
    )
    .flatMap((segment) =>
      buildChunkedCaptionEvents({
        startTimeMs: Math.max(0, segment.startTimeMs - clipStartTimeMs),
        endTimeMs: Math.min(clipDurationMs, segment.endTimeMs - clipStartTimeMs),
        text: segment.text,
      })
    );

  if (events.length > 0) {
    return events;
  }

  const fallbackText = normalizeCaptionText(params.fallbackText);

  if (!fallbackText || clipDurationMs <= 0) {
    return [];
  }

  return buildChunkedCaptionEvents({
    startTimeMs: 0,
    endTimeMs: clipDurationMs,
    text: fallbackText,
  });
}

function buildWordTimedCaptionEvents(params: {
  clipStartTimeMs: number;
  clipDurationMs: number;
  clipEndTimeMs: number;
  transcriptWords: CaptionTranscriptWord[];
}) {
  const overlappingWords = [...params.transcriptWords]
    .sort((left, right) => left.startTimeMs - right.startTimeMs)
    .filter(
      (word) =>
        normalizeCaptionText(word.text).length > 0 &&
        word.startTimeMs < params.clipEndTimeMs &&
        word.endTimeMs > params.clipStartTimeMs
    );
  const groups: CaptionTranscriptWord[][] = [];
  let currentGroup: CaptionTranscriptWord[] = [];

  for (const word of overlappingWords) {
    const normalizedWord = {
      ...word,
      text: normalizeCaptionText(word.text),
    };
    const nextGroup = [...currentGroup, normalizedWord];
    const nextText = nextGroup.map((item) => item.text).join(' ');

    if (
      nextGroup.length <= MAX_CAPTION_WORD_COUNT &&
      nextText.length <= MAX_CAPTION_CHARACTER_COUNT
    ) {
      currentGroup = nextGroup;
      continue;
    }

    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }

    currentGroup = [normalizedWord];
  }

  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  return groups
    .map((group) => {
      const firstWord = group[0];
      const lastWord = group.at(-1);

      if (!firstWord || !lastWord) {
        return null;
      }

      return {
        startTimeMs: Math.max(0, firstWord.startTimeMs - params.clipStartTimeMs),
        endTimeMs: Math.min(
          params.clipDurationMs,
          lastWord.endTimeMs - params.clipStartTimeMs
        ),
        text: group.map((word) => word.text).join(' '),
      };
    })
    .filter(
      (
        event
      ): event is {
        startTimeMs: number;
        endTimeMs: number;
        text: string;
      } => event !== null && event.endTimeMs > event.startTimeMs
    );
}

function buildChunkedCaptionEvents(params: {
  startTimeMs: number;
  endTimeMs: number;
  text: string;
}) {
  const startTimeMs = Math.max(0, params.startTimeMs);
  const endTimeMs = Math.max(startTimeMs, params.endTimeMs);
  const durationMs = endTimeMs - startTimeMs;
  const chunks = splitCaptionTextIntoChunks(params.text);
  const chunkDurationMs = getChunkDurationMs(durationMs, chunks.length);

  if (durationMs <= 0 || chunks.length === 0 || chunkDurationMs <= 0) {
    return [];
  }

  return chunks
    .map((chunk, index) => {
      const chunkStartTimeMs = startTimeMs + Math.round(index * chunkDurationMs);
      const chunkEndTimeMs = Math.min(
        endTimeMs,
        startTimeMs + Math.round((index + 1) * chunkDurationMs)
      );

      return {
        startTimeMs: chunkStartTimeMs,
        endTimeMs: chunkEndTimeMs,
        text: chunk.text,
      };
    })
    .filter((event) => event.endTimeMs > event.startTimeMs);
}

function getChunkDurationMs(totalDurationMs: number, chunkCount: number) {
  if (chunkCount <= 0 || totalDurationMs <= 0) {
    return 0;
  }

  const totalTargetDurationMs = TARGET_CAPTION_DURATION_MS * chunkCount;

  if (totalTargetDurationMs <= totalDurationMs) {
    return TARGET_CAPTION_DURATION_MS;
  }

  const compressedDurationMs = Math.floor(totalDurationMs / chunkCount);

  return Math.max(
    Math.min(compressedDurationMs, MAX_CAPTION_DURATION_MS),
    Math.min(MIN_CAPTION_DURATION_MS, compressedDurationMs)
  );
}

export function buildRenderedClipAssCaptions(params: RenderCaptionParams) {
  const eventLines = buildRenderedClipCaptionEvents(params).map(
    (event) =>
      `Dialogue: 0,${formatAssTimestamp(event.startTimeMs)},${formatAssTimestamp(event.endTimeMs)},Default,,0,0,0,,${escapeAssText(event.text)}`
  );

  if (eventLines.length === 0) {
    return null;
  }

  return `${buildAssHeader(params.fontFamily)}\n${eventLines.join('\n')}\n`;
}
