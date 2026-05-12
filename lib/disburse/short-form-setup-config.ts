import 'server-only';

export const SHORT_FORM_CLIP_LENGTH_VALUES = [
  'auto',
  '15-30s',
  '30-60s',
  '60-90s',
  '1-3m'
] as const;

export type ShortFormClipLengthValue =
  (typeof SHORT_FORM_CLIP_LENGTH_VALUES)[number];

export const DEFAULT_SHORT_FORM_CLIP_LENGTH: ShortFormClipLengthValue = '30-60s';
export const DEFAULT_SHORT_FORM_AUTO_HOOK_ENABLED = true;
export const DEFAULT_SHORT_FORM_FACECAM_DETECTION_ENABLED = true;

export type ShortFormClipWindowConfig = {
  minDurationMs: number;
  targetDurationMs: number;
  maxDurationMs: number;
  maxExcerptChars: number;
};

const CLIP_WINDOW_CONFIGS: Record<
  ShortFormClipLengthValue,
  ShortFormClipWindowConfig
> = {
  auto: {
    minDurationMs: 30_000,
    targetDurationMs: 45_000,
    maxDurationMs: 60_000,
    maxExcerptChars: 1_200
  },
  '15-30s': {
    minDurationMs: 15_000,
    targetDurationMs: 22_500,
    maxDurationMs: 30_000,
    maxExcerptChars: 900
  },
  '30-60s': {
    minDurationMs: 30_000,
    targetDurationMs: 45_000,
    maxDurationMs: 60_000,
    maxExcerptChars: 1_200
  },
  '60-90s': {
    minDurationMs: 60_000,
    targetDurationMs: 75_000,
    maxDurationMs: 90_000,
    maxExcerptChars: 1_800
  },
  '1-3m': {
    minDurationMs: 60_000,
    targetDurationMs: 120_000,
    maxDurationMs: 180_000,
    maxExcerptChars: 3_200
  }
};

export function normalizeShortFormClipLength(
  value: string | null | undefined
): ShortFormClipLengthValue {
  if (
    value &&
    SHORT_FORM_CLIP_LENGTH_VALUES.includes(value as ShortFormClipLengthValue)
  ) {
    return value as ShortFormClipLengthValue;
  }

  return DEFAULT_SHORT_FORM_CLIP_LENGTH;
}

export function parseShortFormClipLengthFromInstructions(
  instructions: string | null | undefined
) {
  const match = instructions?.match(/^Clip length:\s*(.+)$/m);

  return normalizeShortFormClipLength(match?.[1]?.trim());
}

export function getShortFormClipWindowConfig(
  clipLength: ShortFormClipLengthValue
) {
  return CLIP_WINDOW_CONFIGS[clipLength];
}

export function parseShortFormAutoHookEnabledFromInstructions(
  instructions: string | null | undefined
) {
  const match = instructions?.match(/^Auto hook:\s*(enabled|disabled)$/m);

  if (!match) {
    return DEFAULT_SHORT_FORM_AUTO_HOOK_ENABLED;
  }

  return match[1] === 'enabled';
}

export function parseShortFormFacecamDetectionEnabledFromInstructions(
  instructions: string | null | undefined
) {
  const match = instructions?.match(/^Facecam detection:\s*(enabled|disabled)$/m);

  if (!match) {
    return DEFAULT_SHORT_FORM_FACECAM_DETECTION_ENABLED;
  }

  return match[1] === 'enabled';
}
