export const FACECAM_DETECTION_STALE_MS = 10 * 60 * 1000;

export const FACECAM_DETECTION_STALE_FAILURE_REASON =
  'Facecam detection worker stalled and the job will be retried automatically.';

export function isStaleFacecamDetectionStartedAt(
  startedAt: Date | null | undefined,
  now: Date = new Date()
) {
  if (!startedAt) {
    return false;
  }

  return startedAt.getTime() <= now.getTime() - FACECAM_DETECTION_STALE_MS;
}
