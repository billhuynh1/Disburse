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

  if (
    normalized.includes('ffmpeg transcription prep failed') ||
    normalized.includes('ffmpeg transcription chunking failed') ||
    normalized.includes('ffprobe transcription prep failed')
  ) {
    return 'This upload could not be prepared for transcription.';
  }

  if (
    normalized.includes('25 mb file limit') ||
    normalized.includes('too large to transcribe with the current setup') ||
    normalized.includes('exceeds')
  ) {
    return 'This upload is too large to transcribe with the current setup.';
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

  if (
    normalized.includes('source asset was not marked ready') ||
    normalized.includes('transcript was not marked ready')
  ) {
    return 'Transcription finished, but the transcript could not be saved as ready.';
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

function normalizeRenderFailure(message: string) {
  const normalized = message.toLowerCase();

  if (normalized.includes('approve this clip candidate')) {
    return 'Approve this clip candidate before rendering it.';
  }

  if (normalized.includes('uploaded videos')) {
    return 'Rendered clips are only supported for uploaded videos right now.';
  }

  if (normalized.includes('source asset is not ready')) {
    return 'This source asset is not ready for clip rendering yet.';
  }

  if (normalized.includes('storage download failed')) {
    return 'We could not download the source video for clip rendering.';
  }

  if (normalized.includes('storage upload failed')) {
    return 'We could not upload the rendered clip right now.';
  }

  if (normalized.includes('ffmpeg render failed')) {
    return 'We could not render this clip right now.';
  }

  if (normalized.includes('render the trimmed clip successfully')) {
    return 'Render the trimmed clip before making a vertical version.';
  }

  if (normalized.includes('ffmpeg vertical render failed')) {
    return 'We could not create the vertical short-form version right now.';
  }

  return 'We could not render this clip right now.';
}

function normalizeFacecamDetectionFailure(message: string) {
  const normalized = message.toLowerCase();

  if (normalized.includes('environment variable is not set')) {
    return 'Facecam detection is not configured correctly right now.';
  }

  if (normalized.includes('uploaded videos')) {
    return 'Facecam detection is only supported for uploaded videos right now.';
  }

  if (normalized.includes('source asset is not ready')) {
    return 'This source asset is not ready for facecam detection yet.';
  }

  if (normalized.includes('storage metadata')) {
    return 'This source video is missing the metadata needed for facecam detection.';
  }

  if (
    normalized.includes('media api') ||
    normalized.includes('facecam detection') ||
    normalized.includes('video could not be opened')
  ) {
    return 'We could not detect a facecam in this clip right now.';
  }

  return 'We could not detect a facecam in this clip right now.';
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
    case JobType.RENDER_CLIP_CANDIDATE:
    case JobType.FORMAT_RENDERED_CLIP_SHORT_FORM:
      return normalizeRenderFailure(message);
    case JobType.DETECT_CLIP_FACECAM:
      return normalizeFacecamDetectionFailure(message);
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
