import 'server-only';

import { JobType } from '@/lib/db/schema';

function readErrorMessage(error: unknown) {
  return error instanceof Error ? error.message.trim() : 'Unknown pipeline error.';
}

function normalizeTranscriptionFailure(message: string) {
  const normalized = message.toLowerCase();

  if (normalized.includes('environment variable is not set')) {
    return 'Transcription is not configured correctly right now.';
  }

  if (normalized.includes('uploaded file format is not supported')) {
    return 'This file format is not supported for transcription.';
  }

  if (normalized.includes('25 mb file limit') || normalized.includes('exceeds')) {
    return 'This file is too large for the current transcription step.';
  }

  if (
    normalized.includes("response_format") ||
    normalized.includes('timestamp') ||
    normalized.includes('segment')
  ) {
    return 'We could not generate a timestamped transcript with the current transcription setup.';
  }

  if (normalized.includes('storage download failed')) {
    return 'We could not download the uploaded file for transcription.';
  }

  if (normalized.includes('unexpected response')) {
    return 'Transcription returned an unexpected response.';
  }

  return 'We could not transcribe this source asset right now.';
}

function normalizeYoutubeFailure(message: string) {
  const normalized = message.toLowerCase();

  if (normalized.includes('does not expose a transcript track')) {
    return 'This YouTube video does not have a usable transcript.';
  }

  if (normalized.includes('no usable youtube transcript track')) {
    return 'We could not find a usable transcript track for this YouTube video.';
  }

  if (normalized.includes('did not contain usable timestamped text')) {
    return 'This YouTube transcript could not be turned into timestamped clip data.';
  }

  if (normalized.includes('invalid') || normalized.includes('not supported')) {
    return 'This YouTube URL is not supported.';
  }

  return 'We could not import a usable YouTube transcript for this source.';
}

function normalizeShortFormFailure(message: string) {
  const normalized = message.toLowerCase();

  if (normalized.includes('ready transcript is required')) {
    return 'Generate clips after the transcript is ready.';
  }

  if (normalized.includes('does not include timestamps')) {
    return 'This transcript does not include timestamps for clip generation.';
  }

  if (normalized.includes('no usable short-form windows')) {
    return 'We could not find any usable short-form moments in this transcript.';
  }

  if (normalized.includes('no usable short-form clip candidates')) {
    return 'We could not generate strong short-form clip candidates from this transcript.';
  }

  if (
    normalized.includes('openai short-form generation failed') ||
    normalized.includes('invalid structured data') ||
    normalized.includes('did not return json') ||
    normalized.includes('unexpected response')
  ) {
    return 'We could not generate short-form clip candidates right now.';
  }

  return 'We could not generate short-form clip candidates right now.';
}

export function getUserSafePipelineFailureReason(
  jobType: JobType,
  error: unknown
) {
  const message = readErrorMessage(error);

  switch (jobType) {
    case JobType.TRANSCRIBE_SOURCE_ASSET:
      return normalizeTranscriptionFailure(message);
    case JobType.INGEST_YOUTUBE_SOURCE_ASSET:
      return normalizeYoutubeFailure(message);
    case JobType.GENERATE_SHORT_FORM_PACK:
      return normalizeShortFormFailure(message);
    default:
      return 'Pipeline processing failed.';
  }
}

export function logPipelineError(jobType: JobType, error: unknown, context: Record<string, unknown>) {
  const message = readErrorMessage(error);

  console.error(`[pipeline:${jobType}] ${message}`, {
    ...context,
    rawError: error,
  });
}
