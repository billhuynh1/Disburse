export type ClipTimingInput = {
  startTimeMs: number;
  endTimeMs: number;
  durationMs?: number;
};

function isValidInteger(value: number) {
  return Number.isInteger(value) && Number.isFinite(value);
}

export function validateClipTiming(
  timing: ClipTimingInput,
  label = 'Clip timing'
) {
  if (!isValidInteger(timing.startTimeMs) || timing.startTimeMs < 0) {
    throw new Error(`${label} has an invalid start time.`);
  }

  if (!isValidInteger(timing.endTimeMs) || timing.endTimeMs <= timing.startTimeMs) {
    throw new Error(`${label} has an invalid end time.`);
  }

  const expectedDurationMs = timing.endTimeMs - timing.startTimeMs;

  if (
    typeof timing.durationMs !== 'undefined' &&
    (!isValidInteger(timing.durationMs) || timing.durationMs !== expectedDurationMs)
  ) {
    throw new Error(`${label} has an invalid duration.`);
  }

  return {
    startTimeMs: timing.startTimeMs,
    endTimeMs: timing.endTimeMs,
    durationMs: expectedDurationMs,
  };
}
