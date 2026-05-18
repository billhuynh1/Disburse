import 'server-only';

import { z } from 'zod';

const mediaApiFacecamCandidateSchema = z.object({
  rank: z.number().int().positive(),
  xPx: z.number().int().nonnegative(),
  yPx: z.number().int().nonnegative(),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  confidence: z.number().int().min(0).max(100),
});

const mediaApiFacecamDetectionResponseSchema = z.object({
  frameWidth: z.number().int().positive(),
  frameHeight: z.number().int().positive(),
  sampledFrameCount: z.number().int().nonnegative(),
  candidates: z.array(mediaApiFacecamCandidateSchema),
  detectionStage: z.string().trim().min(1).nullable().optional(),
  debugSummary: z.string().trim().min(1).nullable().optional(),
});

export type MediaApiFacecamDetectionResponse = z.infer<
  typeof mediaApiFacecamDetectionResponseSchema
>;

type DetectFacecamRegionsInput = {
  sourceDownloadUrl: string;
  sourceFilename: string;
  startTimeMs: number;
  endTimeMs: number;
  samplingIntervalMs?: number;
  maxCandidateBoxes?: number;
};

export type MediaApiFacecamErrorKind =
  | 'timeout'
  | 'aborted'
  | 'network_error'
  | 'http_error'
  | 'invalid_response';

export class MediaApiFacecamDetectionError extends Error {
  kind: MediaApiFacecamErrorKind;
  statusCode: number | null;
  timeoutMs: number;
  durationMs: number;
  expectedAbort: boolean;

  constructor(params: {
    kind: MediaApiFacecamErrorKind;
    message: string;
    statusCode?: number | null;
    timeoutMs: number;
    durationMs: number;
    expectedAbort?: boolean;
    cause?: unknown;
  }) {
    super(params.message, { cause: params.cause });
    this.name = 'MediaApiFacecamDetectionError';
    this.kind = params.kind;
    this.statusCode = params.statusCode ?? null;
    this.timeoutMs = params.timeoutMs;
    this.durationMs = params.durationMs;
    this.expectedAbort = params.expectedAbort ?? false;
  }
}

function getRequiredEnvVar(name: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} environment variable is not set.`);
  }

  return value;
}

async function readErrorMessage(response: Response) {
  const body = await response.json().catch(() => null);

  if (typeof body?.detail === 'string') {
    return body.detail;
  }

  if (typeof body?.error === 'string') {
    return body.error;
  }

  return `Media API request failed with status ${response.status}.`;
}

export function getFacecamDetectionTimeoutMs() {
  const value = Number(process.env.MEDIA_API_FACECAM_TIMEOUT_MS);

  if (!Number.isFinite(value) || value < 1) {
    return 120_000;
  }

  return Math.floor(value);
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

export async function detectFacecamRegions(
  input: DetectFacecamRegionsInput
): Promise<MediaApiFacecamDetectionResponse> {
  const baseUrl = getRequiredEnvVar('MEDIA_API_BASE_URL').replace(/\/$/, '');
  const secret = getRequiredEnvVar('MEDIA_API_SECRET');
  const controller = new AbortController();
  const timeoutMs = getFacecamDetectionTimeoutMs();
  const startedAt = Date.now();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/internal/facecam-detections`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new MediaApiFacecamDetectionError({
        kind: 'http_error',
        message: await readErrorMessage(response),
        statusCode: response.status,
        timeoutMs,
        durationMs: Date.now() - startedAt,
      });
    }

    const body = await response.json().catch(() => null);
    const parsed = mediaApiFacecamDetectionResponseSchema.safeParse(body);

    if (!parsed.success) {
      throw new MediaApiFacecamDetectionError({
        kind: 'invalid_response',
        message: 'Media API returned invalid facecam detection data.',
        timeoutMs,
        durationMs: Date.now() - startedAt,
      });
    }

    return parsed.data;
  } catch (error) {
    if (error instanceof MediaApiFacecamDetectionError) {
      throw error;
    }

    if (isAbortError(error)) {
      throw new MediaApiFacecamDetectionError({
        kind: timedOut ? 'timeout' : 'aborted',
        message: timedOut
          ? `Media API facecam detection timed out after ${timeoutMs}ms.`
          : 'Media API facecam detection was aborted.',
        timeoutMs,
        durationMs: Date.now() - startedAt,
        expectedAbort: timedOut,
        cause: error,
      });
    }

    throw new MediaApiFacecamDetectionError({
      kind: 'network_error',
      message:
        error instanceof Error && error.message.trim()
          ? error.message
          : 'Media API facecam detection request failed.',
      timeoutMs,
      durationMs: Date.now() - startedAt,
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }
}
