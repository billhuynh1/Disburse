export const NOTIFICATIONS_REFRESH_EVENT = 'notifications:refresh';

export const NOTIFICATION_TYPE = {
  UPLOAD: 'upload',
  TRANSCRIPT: 'transcript',
  SHORT_FORM_PACK: 'short_form_pack',
  RENDERED_CLIP: 'rendered_clip',
  FACECAM_DETECTION: 'facecam_detection',
  CLIP_PUBLICATION: 'clip_publication',
} as const;

export const NOTIFICATION_OUTCOME = {
  SUCCESS: 'success',
  WARNING: 'warning',
  FAILURE: 'failure',
} as const;

export type NotificationType =
  (typeof NOTIFICATION_TYPE)[keyof typeof NOTIFICATION_TYPE];
export type NotificationOutcome =
  (typeof NOTIFICATION_OUTCOME)[keyof typeof NOTIFICATION_OUTCOME];

export type NotificationCopy = {
  type: NotificationType;
  outcome: NotificationOutcome;
  title: string;
  message: string;
};

export function buildNotificationDedupeKey(params: {
  type: NotificationType;
  entityId: number;
  status: NotificationOutcome;
  eventAt: Date;
}) {
  return [
    params.type,
    params.entityId,
    params.status,
    params.eventAt.toISOString(),
  ].join(':');
}

export function getRenderedClipVariantLabel(variant: string) {
  return variant === 'vertical_short_form' ? 'Vertical clip' : 'Clip';
}

export function getClipPublicationPlatformLabel(platform: string) {
  if (platform === 'youtube') {
    return 'YouTube';
  }

  if (platform === 'tiktok') {
    return 'TikTok';
  }

  return platform.replaceAll('_', ' ');
}

export function buildUploadCompletedNotificationCopy(
  sourceAssetTitle: string
): NotificationCopy {
  return {
    type: NOTIFICATION_TYPE.UPLOAD,
    outcome: NOTIFICATION_OUTCOME.SUCCESS,
    title: 'Upload finished',
    message: `${sourceAssetTitle} was attached and is ready for processing.`,
  };
}

export function buildTranscriptReadyNotificationCopy(
  sourceAssetTitle: string
): NotificationCopy {
  return {
    type: NOTIFICATION_TYPE.TRANSCRIPT,
    outcome: NOTIFICATION_OUTCOME.SUCCESS,
    title: 'Transcript ready',
    message: `${sourceAssetTitle} is ready for downstream workflows.`,
  };
}

export function buildTranscriptFailedNotificationCopy(
  sourceAssetTitle: string,
  failureReason: string | null
): NotificationCopy {
  return {
    type: NOTIFICATION_TYPE.TRANSCRIPT,
    outcome: NOTIFICATION_OUTCOME.FAILURE,
    title: 'Transcript failed',
    message: failureReason || `${sourceAssetTitle} could not be transcribed.`,
  };
}

export function buildShortFormPackReadyNotificationCopy(
  sourceAssetTitle: string
): NotificationCopy {
  return {
    type: NOTIFICATION_TYPE.SHORT_FORM_PACK,
    outcome: NOTIFICATION_OUTCOME.SUCCESS,
    title: 'Clip candidates ready',
    message: `${sourceAssetTitle} now has clip candidates ready to review.`,
  };
}

export function buildShortFormPackFailedNotificationCopy(
  contentPackName: string,
  failureReason: string | null
): NotificationCopy {
  return {
    type: NOTIFICATION_TYPE.SHORT_FORM_PACK,
    outcome: NOTIFICATION_OUTCOME.FAILURE,
    title: 'Clip generation failed',
    message: failureReason || `${contentPackName} could not generate clip candidates.`,
  };
}

export function buildRenderedClipReadyNotificationCopy(params: {
  clipTitle: string;
  variant: string;
}): NotificationCopy {
  return {
    type: NOTIFICATION_TYPE.RENDERED_CLIP,
    outcome: NOTIFICATION_OUTCOME.SUCCESS,
    title: `${getRenderedClipVariantLabel(params.variant)} ready`,
    message: `${params.clipTitle} is rendered and ready to preview.`,
  };
}

export function buildRenderedClipFailedNotificationCopy(params: {
  sourceAssetTitle: string;
  variant: string;
  failureReason: string | null;
}): NotificationCopy {
  return {
    type: NOTIFICATION_TYPE.RENDERED_CLIP,
    outcome: NOTIFICATION_OUTCOME.FAILURE,
    title: `${getRenderedClipVariantLabel(params.variant)} failed`,
    message:
      params.failureReason ||
      `${params.sourceAssetTitle} could not be rendered into a clip.`,
  };
}

export function buildFacecamReadyNotificationCopy(
  clipTitle: string
): NotificationCopy {
  return {
    type: NOTIFICATION_TYPE.FACECAM_DETECTION,
    outcome: NOTIFICATION_OUTCOME.SUCCESS,
    title: 'Facecam detected',
    message: `${clipTitle} has a suggested facecam crop.`,
  };
}

export function buildFacecamNotFoundNotificationCopy(
  clipTitle: string
): NotificationCopy {
  return {
    type: NOTIFICATION_TYPE.FACECAM_DETECTION,
    outcome: NOTIFICATION_OUTCOME.WARNING,
    title: 'No facecam detected',
    message: `${clipTitle} did not have a stable facecam region.`,
  };
}

export function buildFacecamFailedNotificationCopy(params: {
  sourceAssetTitle: string;
  failureReason: string | null;
}): NotificationCopy {
  return {
    type: NOTIFICATION_TYPE.FACECAM_DETECTION,
    outcome: NOTIFICATION_OUTCOME.FAILURE,
    title: 'Facecam detection failed',
    message:
      params.failureReason ||
      `${params.sourceAssetTitle} could not be analyzed for a facecam.`,
  };
}

export function buildClipPublicationPublishedNotificationCopy(params: {
  clipTitle: string;
  platform: string;
}): NotificationCopy {
  return {
    type: NOTIFICATION_TYPE.CLIP_PUBLICATION,
    outcome: NOTIFICATION_OUTCOME.SUCCESS,
    title: 'Clip published',
    message: `${params.clipTitle} was published to ${getClipPublicationPlatformLabel(params.platform)}.`,
  };
}

export function buildClipPublicationFailedNotificationCopy(params: {
  clipTitle: string;
  platform: string;
  failureReason: string | null;
}): NotificationCopy {
  return {
    type: NOTIFICATION_TYPE.CLIP_PUBLICATION,
    outcome: NOTIFICATION_OUTCOME.FAILURE,
    title: 'Clip publish failed',
    message:
      params.failureReason ||
      `${params.clipTitle} could not be published to ${getClipPublicationPlatformLabel(params.platform)}.`,
  };
}
