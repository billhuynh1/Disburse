import 'server-only';

import { z } from 'zod';
import { getSourceAssetFileExtension } from '@/lib/disburse/source-asset-upload-config';
import { buildSegmentsFromWords } from '@/lib/disburse/transcript-timestamps';

const MB = 1024 * 1024;

export const OPENAI_TRANSCRIPTION_MAX_FILE_SIZE_BYTES = 25 * MB;
export const DEFAULT_OPENAI_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';
export const OPENAI_WORD_TIMESTAMP_TRANSCRIPTION_MODEL = 'whisper-1';

export type TimestampedTranscriptSegment = {
  sequence: number;
  startTimeMs: number;
  endTimeMs: number;
  text: string;
};

export type TimestampedTranscriptWord = {
  sequence: number;
  startTimeMs: number;
  endTimeMs: number;
  text: string;
};

const openAiSupportedExtensions = new Set([
  'mp3',
  'mp4',
  'mpeg',
  'mpga',
  'm4a',
  'wav',
  'webm',
]);

const transcriptionResponseSchema = z.object({
  text: z.string().trim().min(1),
  language: z.string().trim().min(1).nullable().optional(),
  segments: z
    .array(
      z.object({
        start: z.number(),
        end: z.number(),
        text: z.string(),
      })
    )
    .optional()
    .default([]),
  words: z
    .array(
      z.object({
        start: z.number(),
        end: z.number(),
        word: z.string(),
      })
    )
    .optional()
    .default([]),
});

function getRequiredEnvVar(name: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} environment variable is not set.`);
  }

  return value;
}

export function getOpenAiTranscriptionModel() {
  return (
    process.env.OPENAI_TRANSCRIPTION_MODEL?.trim() ||
    DEFAULT_OPENAI_TRANSCRIPTION_MODEL
  );
}

export function getOpenAiWordTimestampTranscriptionModel() {
  return OPENAI_WORD_TIMESTAMP_TRANSCRIPTION_MODEL;
}

export function assertOpenAiTranscriptionSupport(params: {
  filename: string;
  fileSizeBytes: number | null;
}) {
  const extension = getSourceAssetFileExtension(params.filename);

  if (!openAiSupportedExtensions.has(extension)) {
    throw new Error(
      'This uploaded file format is not supported by the current OpenAI transcription step.'
    );
  }

  if (
    typeof params.fileSizeBytes === 'number' &&
    params.fileSizeBytes > OPENAI_TRANSCRIPTION_MAX_FILE_SIZE_BYTES
  ) {
    throw new Error(
      'This uploaded file exceeds OpenAI transcription\'s current 25 MB file limit.'
    );
  }
}

export async function transcribeWithOpenAI(params: {
  file: Blob;
  filename: string;
  language?: string | null;
  wordTimestamps?: boolean;
}) {
  const formData = new FormData();
  const model = params.wordTimestamps
    ? getOpenAiWordTimestampTranscriptionModel()
    : getOpenAiTranscriptionModel();

  formData.append('file', params.file, params.filename);
  formData.append('model', model);
  formData.append('response_format', 'verbose_json');
  formData.append('timestamp_granularities[]', 'segment');

  if (params.wordTimestamps) {
    formData.append('timestamp_granularities[]', 'word');
  }

  if (params.language?.trim()) {
    formData.append('language', params.language.trim());
  }

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getRequiredEnvVar('OPENAI_API_KEY')}`,
    },
    body: formData,
  });
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    const apiMessage =
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof body.error === 'object' &&
      body.error !== null &&
      'message' in body.error &&
      typeof body.error.message === 'string'
        ? body.error.message
        : null;

    throw new Error(
      apiMessage || `OpenAI transcription failed with status ${response.status}.`
    );
  }

  const parsed = transcriptionResponseSchema.safeParse(body);

  if (!parsed.success) {
    throw new Error('OpenAI transcription returned an unexpected response.');
  }

  const segments = parsed.data.segments
    .map((segment, index) => ({
      sequence: index,
      startTimeMs: Math.max(0, Math.round(segment.start * 1000)),
      endTimeMs: Math.max(0, Math.round(segment.end * 1000)),
      text: segment.text.trim(),
    }))
    .filter(
      (segment) =>
        segment.text.length > 0 && segment.endTimeMs > segment.startTimeMs
    ) satisfies TimestampedTranscriptSegment[];
  const words = parsed.data.words
    .map((word, index) => ({
      sequence: index,
      startTimeMs: Math.max(0, Math.round(word.start * 1000)),
      endTimeMs: Math.max(0, Math.round(word.end * 1000)),
      text: word.word.trim(),
    }))
    .filter(
      (word) => word.text.length > 0 && word.endTimeMs > word.startTimeMs
    ) satisfies TimestampedTranscriptWord[];

  return {
    text: parsed.data.text,
    language: parsed.data.language?.trim() || params.language?.trim() || null,
    segments: segments.length > 0 ? segments : buildSegmentsFromWords(words),
    words,
    model,
  };
}
