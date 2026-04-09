import 'server-only';

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  assertOpenAiTranscriptionSupport,
  OPENAI_TRANSCRIPTION_MAX_FILE_SIZE_BYTES,
  type TimestampedTranscriptSegment,
} from '@/lib/disburse/openai-transcription';
import { createPresignedDownload } from '@/lib/disburse/s3-storage';

const execFileAsync = promisify(execFile);
const FFMPEG_BINARY = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
const FFPROBE_BINARY =
  process.env.FFPROBE_PATH?.trim() ||
  (process.env.FFMPEG_PATH?.trim()
    ? path.join(path.dirname(process.env.FFMPEG_PATH.trim()), 'ffprobe')
    : 'ffprobe');

const MB = 1024 * 1024;
const TRANSCRIPTION_AUDIO_BITRATE = '32k';
const TRANSCRIPTION_AUDIO_SAMPLE_RATE = '16000';
const TRANSCRIPTION_AUDIO_CHANNELS = '1';
const TRANSCRIPTION_AUDIO_EXTENSION = '.mp3';
const TRANSCRIPTION_AUDIO_MIME_TYPE = 'audio/mpeg';
const TRANSCRIPTION_CHUNK_DURATION_MS = 30 * 60 * 1000;
const TRANSCRIPTION_TARGET_MAX_FILE_SIZE_BYTES = Math.min(
  OPENAI_TRANSCRIPTION_MAX_FILE_SIZE_BYTES - 2 * MB,
  20 * MB
);

export type PreparedTranscriptionChunk = {
  sequence: number;
  startOffsetMs: number;
  endOffsetMs: number;
  filename: string;
  file: Blob;
};

type ChunkTranscriptionResult = {
  sequence: number;
  startOffsetMs: number;
  text: string;
  language: string | null;
  segments: TimestampedTranscriptSegment[];
};

async function downloadSourceAssetBuffer(storageKey: string) {
  const download = createPresignedDownload({ storageKey });
  const response = await fetch(download.downloadUrl, {
    method: download.method,
  });

  if (!response.ok) {
    throw new Error(`Storage download failed with status ${response.status}.`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function formatSeconds(totalMs: number) {
  return (Math.max(totalMs, 0) / 1000).toFixed(3);
}

async function runAudioExtraction(params: {
  inputPath: string;
  outputPath: string;
}) {
  try {
    await execFileAsync(FFMPEG_BINARY, [
      '-y',
      '-i',
      params.inputPath,
      '-vn',
      '-ac',
      TRANSCRIPTION_AUDIO_CHANNELS,
      '-ar',
      TRANSCRIPTION_AUDIO_SAMPLE_RATE,
      '-c:a',
      'libmp3lame',
      '-b:a',
      TRANSCRIPTION_AUDIO_BITRATE,
      params.outputPath,
    ]);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'ffmpeg failed unexpectedly.';
    throw new Error(`ffmpeg transcription prep failed: ${message}`);
  }
}

async function runAudioChunkExtraction(params: {
  inputPath: string;
  outputPath: string;
  startTimeMs: number;
  durationMs: number;
}) {
  try {
    await execFileAsync(FFMPEG_BINARY, [
      '-y',
      '-ss',
      formatSeconds(params.startTimeMs),
      '-i',
      params.inputPath,
      '-t',
      formatSeconds(params.durationMs),
      '-vn',
      '-ac',
      TRANSCRIPTION_AUDIO_CHANNELS,
      '-ar',
      TRANSCRIPTION_AUDIO_SAMPLE_RATE,
      '-c:a',
      'libmp3lame',
      '-b:a',
      TRANSCRIPTION_AUDIO_BITRATE,
      params.outputPath,
    ]);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'ffmpeg failed unexpectedly.';
    throw new Error(`ffmpeg transcription chunking failed: ${message}`);
  }
}

async function probeMediaDurationMs(filePath: string) {
  try {
    const { stdout } = await execFileAsync(FFPROBE_BINARY, [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    const durationSeconds = Number.parseFloat(stdout.trim());

    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error('Invalid media duration.');
    }

    return Math.round(durationSeconds * 1000);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'ffprobe failed unexpectedly.';
    throw new Error(`ffprobe transcription prep failed: ${message}`);
  }
}

async function readPreparedChunk(params: {
  filePath: string;
  filename: string;
  sequence: number;
  startOffsetMs: number;
  endOffsetMs: number;
}) {
  const stats = await fs.stat(params.filePath);

  assertOpenAiTranscriptionSupport({
    filename: params.filename,
    fileSizeBytes: stats.size,
  });

  const buffer = await fs.readFile(params.filePath);

  return {
    sequence: params.sequence,
    startOffsetMs: params.startOffsetMs,
    endOffsetMs: params.endOffsetMs,
    filename: params.filename,
    file: new Blob([buffer], {
      type: TRANSCRIPTION_AUDIO_MIME_TYPE,
    }),
  } satisfies PreparedTranscriptionChunk;
}

export async function withPreparedTranscriptionChunks<T>(
  params: {
    storageKey: string;
    originalFilename: string;
  },
  callback: (chunks: PreparedTranscriptionChunk[]) => Promise<T>
) {
  const sourceBuffer = await downloadSourceAssetBuffer(params.storageKey);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'disburse-transcribe-'));
  const inputExtension = path.extname(params.originalFilename) || '.bin';
  const inputPath = path.join(tempDir, `source${inputExtension}`);
  const extractedAudioPath = path.join(tempDir, `prepared${TRANSCRIPTION_AUDIO_EXTENSION}`);

  try {
    await fs.writeFile(inputPath, sourceBuffer);
    await runAudioExtraction({
      inputPath,
      outputPath: extractedAudioPath,
    });

    const extractedStats = await fs.stat(extractedAudioPath);

    if (extractedStats.size <= TRANSCRIPTION_TARGET_MAX_FILE_SIZE_BYTES) {
      const chunk = await readPreparedChunk({
        filePath: extractedAudioPath,
        filename: `transcription-chunk-1${TRANSCRIPTION_AUDIO_EXTENSION}`,
        sequence: 0,
        startOffsetMs: 0,
        endOffsetMs: await probeMediaDurationMs(extractedAudioPath),
      });

      return await callback([chunk]);
    }

    const extractedDurationMs = await probeMediaDurationMs(extractedAudioPath);
    const chunkCount = Math.max(
      1,
      Math.ceil(extractedDurationMs / TRANSCRIPTION_CHUNK_DURATION_MS)
    );
    const chunks: PreparedTranscriptionChunk[] = [];

    for (let index = 0; index < chunkCount; index += 1) {
      const startOffsetMs = index * TRANSCRIPTION_CHUNK_DURATION_MS;
      const remainingDurationMs = extractedDurationMs - startOffsetMs;
      const durationMs = Math.min(
        TRANSCRIPTION_CHUNK_DURATION_MS,
        remainingDurationMs
      );

      if (durationMs <= 0) {
        continue;
      }

      const chunkPath = path.join(
        tempDir,
        `chunk-${String(index + 1).padStart(3, '0')}${TRANSCRIPTION_AUDIO_EXTENSION}`
      );

      await runAudioChunkExtraction({
        inputPath: extractedAudioPath,
        outputPath: chunkPath,
        startTimeMs: startOffsetMs,
        durationMs,
      });

      const chunk = await readPreparedChunk({
        filePath: chunkPath,
        filename: `transcription-chunk-${index + 1}${TRANSCRIPTION_AUDIO_EXTENSION}`,
        sequence: index,
        startOffsetMs,
        endOffsetMs: startOffsetMs + durationMs,
      });

      if (chunk.file.size > TRANSCRIPTION_TARGET_MAX_FILE_SIZE_BYTES) {
        throw new Error(
          'This upload is too large to transcribe with the current setup.'
        );
      }

      chunks.push(chunk);
    }

    if (chunks.length === 0) {
      throw new Error('This upload could not be prepared for transcription.');
    }

    return await callback(chunks);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export function mergeTimestampedTranscriptionChunks(
  transcriptions: ChunkTranscriptionResult[]
) {
  const sorted = [...transcriptions].sort((left, right) => left.sequence - right.sequence);
  const segments: TimestampedTranscriptSegment[] = [];
  const textParts: string[] = [];
  let language: string | null = null;

  for (const transcription of sorted) {
    if (!language && transcription.language?.trim()) {
      language = transcription.language.trim();
    }

    if (transcription.text.trim()) {
      textParts.push(transcription.text.trim());
    }

    for (const segment of transcription.segments) {
      const startTimeMs = transcription.startOffsetMs + segment.startTimeMs;
      const endTimeMs = transcription.startOffsetMs + segment.endTimeMs;

      if (endTimeMs <= startTimeMs || !segment.text.trim()) {
        continue;
      }

      segments.push({
        sequence: segments.length,
        startTimeMs,
        endTimeMs,
        text: segment.text.trim(),
      });
    }
  }

  if (textParts.length === 0 || segments.length === 0) {
    throw new Error('OpenAI transcription did not return usable timestamped segments.');
  }

  return {
    content: textParts.join('\n\n'),
    language,
    segments,
  };
}
