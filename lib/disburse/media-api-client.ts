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

export async function detectFacecamRegions(
  input: DetectFacecamRegionsInput
): Promise<MediaApiFacecamDetectionResponse> {
  const baseUrl = getRequiredEnvVar('MEDIA_API_BASE_URL').replace(/\/$/, '');
  const secret = getRequiredEnvVar('MEDIA_API_SECRET');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

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
      throw new Error(await readErrorMessage(response));
    }

    const body = await response.json().catch(() => null);
    const parsed = mediaApiFacecamDetectionResponseSchema.safeParse(body);

    if (!parsed.success) {
      throw new Error('Media API returned invalid facecam detection data.');
    }

    return parsed.data;
  } finally {
    clearTimeout(timeout);
  }
}

