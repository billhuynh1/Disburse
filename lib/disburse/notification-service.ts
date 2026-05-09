import 'server-only';

import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import {
  clipCandidates,
  clipPublications,
  contentPacks,
  notifications,
  renderedClips,
  sourceAssets,
  transcripts,
} from '@/lib/db/schema';
import {
  buildNotificationDedupeKey,
  buildClipPublicationFailedNotificationCopy,
  buildClipPublicationPublishedNotificationCopy,
  buildFacecamFailedNotificationCopy,
  buildFacecamNotFoundNotificationCopy,
  buildFacecamReadyNotificationCopy,
  buildRenderedClipFailedNotificationCopy,
  buildRenderedClipReadyNotificationCopy,
  buildShortFormPackFailedNotificationCopy,
  buildShortFormPackReadyNotificationCopy,
  buildTranscriptFailedNotificationCopy,
  buildTranscriptReadyNotificationCopy,
  buildUploadCompletedNotificationCopy,
} from '@/lib/disburse/notification-copy';

type CreateNotificationParams = {
  userId: number;
  type: string;
  status: string;
  title: string;
  message: string;
  entityType: string;
  entityId: number;
  actionUrl: string | null;
  dedupeKey: string;
};

function buildProjectActionUrl(projectId: number, suffix?: string) {
  return suffix
    ? `/dashboard/projects/${projectId}/${suffix}`
    : `/dashboard/projects/${projectId}`;
}

async function createNotification(params: CreateNotificationParams) {
  await db
    .insert(notifications)
    .values({
      userId: params.userId,
      type: params.type,
      status: params.status,
      title: params.title,
      message: params.message,
      entityType: params.entityType,
      entityId: params.entityId,
      actionUrl: params.actionUrl,
      dedupeKey: params.dedupeKey,
    })
    .onConflictDoNothing({
      target: notifications.dedupeKey,
    });
}

export async function createUploadCompletedNotification(sourceAssetId: number) {
  const sourceAsset = await db.query.sourceAssets.findFirst({
    where: eq(sourceAssets.id, sourceAssetId),
  });

  if (!sourceAsset) {
    return;
  }

  const copy = buildUploadCompletedNotificationCopy(sourceAsset.title);

  await createNotification({
    userId: sourceAsset.userId,
    type: copy.type,
    status: copy.outcome,
    title: copy.title,
    message: copy.message,
    entityType: 'source_asset',
    entityId: sourceAsset.id,
    actionUrl: buildProjectActionUrl(sourceAsset.projectId, 'setup'),
    dedupeKey: buildNotificationDedupeKey({
      type: copy.type,
      entityId: sourceAsset.id,
      status: copy.outcome,
      eventAt: sourceAsset.createdAt,
    }),
  });
}

export async function createTranscriptReadyNotification(sourceAssetId: number) {
  const transcript = await db.query.transcripts.findFirst({
    where: eq(transcripts.sourceAssetId, sourceAssetId),
    with: {
      sourceAsset: true,
    },
  });

  if (!transcript) {
    return;
  }

  const copy = buildTranscriptReadyNotificationCopy(transcript.sourceAsset.title);

  await createNotification({
    userId: transcript.userId,
    type: copy.type,
    status: copy.outcome,
    title: copy.title,
    message: copy.message,
    entityType: 'transcript',
    entityId: transcript.id,
    actionUrl: buildProjectActionUrl(transcript.sourceAsset.projectId),
    dedupeKey: buildNotificationDedupeKey({
      type: copy.type,
      entityId: transcript.id,
      status: copy.outcome,
      eventAt: transcript.updatedAt,
    }),
  });
}

export async function createTranscriptFailedNotification(sourceAssetId: number) {
  const transcript = await db.query.transcripts.findFirst({
    where: eq(transcripts.sourceAssetId, sourceAssetId),
    with: {
      sourceAsset: true,
    },
  });

  if (!transcript) {
    return;
  }

  const copy = buildTranscriptFailedNotificationCopy(
    transcript.sourceAsset.title,
    transcript.failureReason
  );

  await createNotification({
    userId: transcript.userId,
    type: copy.type,
    status: copy.outcome,
    title: copy.title,
    message: copy.message,
    entityType: 'transcript',
    entityId: transcript.id,
    actionUrl: buildProjectActionUrl(transcript.sourceAsset.projectId),
    dedupeKey: buildNotificationDedupeKey({
      type: copy.type,
      entityId: transcript.id,
      status: copy.outcome,
      eventAt: transcript.updatedAt,
    }),
  });
}

export async function createShortFormPackReadyNotification(contentPackId: number) {
  const contentPack = await db.query.contentPacks.findFirst({
    where: eq(contentPacks.id, contentPackId),
    with: {
      sourceAsset: true,
    },
  });

  if (!contentPack) {
    return;
  }

  const copy = buildShortFormPackReadyNotificationCopy(contentPack.sourceAsset.title);

  await createNotification({
    userId: contentPack.userId,
    type: copy.type,
    status: copy.outcome,
    title: copy.title,
    message: copy.message,
    entityType: 'content_pack',
    entityId: contentPack.id,
    actionUrl: buildProjectActionUrl(contentPack.projectId),
    dedupeKey: buildNotificationDedupeKey({
      type: copy.type,
      entityId: contentPack.id,
      status: copy.outcome,
      eventAt: contentPack.updatedAt,
    }),
  });
}

export async function createShortFormPackFailedNotification(contentPackId: number) {
  const contentPack = await db.query.contentPacks.findFirst({
    where: eq(contentPacks.id, contentPackId),
  });

  if (!contentPack) {
    return;
  }

  const copy = buildShortFormPackFailedNotificationCopy(
    contentPack.name,
    contentPack.failureReason
  );

  await createNotification({
    userId: contentPack.userId,
    type: copy.type,
    status: copy.outcome,
    title: copy.title,
    message: copy.message,
    entityType: 'content_pack',
    entityId: contentPack.id,
    actionUrl: buildProjectActionUrl(contentPack.projectId),
    dedupeKey: buildNotificationDedupeKey({
      type: copy.type,
      entityId: contentPack.id,
      status: copy.outcome,
      eventAt: contentPack.updatedAt,
    }),
  });
}

export async function createRenderedClipReadyNotification(renderedClipId: number) {
  const renderedClip = await db.query.renderedClips.findFirst({
    where: eq(renderedClips.id, renderedClipId),
    with: {
      contentPack: true,
      clipCandidate: true,
    },
  });

  if (!renderedClip) {
    return;
  }

  const copy = buildRenderedClipReadyNotificationCopy({
    clipTitle: renderedClip.title || renderedClip.clipCandidate.title,
    variant: renderedClip.variant,
  });

  await createNotification({
    userId: renderedClip.userId,
    type: copy.type,
    status: copy.outcome,
    title: copy.title,
    message: copy.message,
    entityType: 'rendered_clip',
    entityId: renderedClip.id,
    actionUrl: buildProjectActionUrl(renderedClip.contentPack.projectId),
    dedupeKey: buildNotificationDedupeKey({
      type: copy.type,
      entityId: renderedClip.id,
      status: copy.outcome,
      eventAt: renderedClip.updatedAt,
    }),
  });
}

export async function createRenderedClipFailedNotification(renderedClipId: number) {
  const renderedClip = await db.query.renderedClips.findFirst({
    where: eq(renderedClips.id, renderedClipId),
    with: {
      contentPack: true,
      sourceAsset: true,
    },
  });

  if (!renderedClip) {
    return;
  }

  const copy = buildRenderedClipFailedNotificationCopy({
    sourceAssetTitle: renderedClip.sourceAsset.title,
    variant: renderedClip.variant,
    failureReason: renderedClip.failureReason,
  });

  await createNotification({
    userId: renderedClip.userId,
    type: copy.type,
    status: copy.outcome,
    title: copy.title,
    message: copy.message,
    entityType: 'rendered_clip',
    entityId: renderedClip.id,
    actionUrl: buildProjectActionUrl(renderedClip.contentPack.projectId),
    dedupeKey: buildNotificationDedupeKey({
      type: copy.type,
      entityId: renderedClip.id,
      status: copy.outcome,
      eventAt: renderedClip.updatedAt,
    }),
  });
}

export async function createFacecamDetectionNotification(clipCandidateId: number) {
  const clipCandidate = await db.query.clipCandidates.findFirst({
    where: eq(clipCandidates.id, clipCandidateId),
    with: {
      contentPack: true,
      sourceAsset: true,
    },
  });

  if (!clipCandidate || !clipCandidate.facecamDetectionStatus) {
    return;
  }

  const copy =
    clipCandidate.facecamDetectionStatus === 'ready'
      ? buildFacecamReadyNotificationCopy(clipCandidate.title)
      : clipCandidate.facecamDetectionStatus === 'not_found'
        ? buildFacecamNotFoundNotificationCopy(clipCandidate.title)
        : buildFacecamFailedNotificationCopy({
            sourceAssetTitle: clipCandidate.sourceAsset.title,
            failureReason: clipCandidate.facecamDetectionFailureReason,
          });

  await createNotification({
    userId: clipCandidate.userId,
    type: copy.type,
    status: copy.outcome,
    title: copy.title,
    message: copy.message,
    entityType: 'clip_candidate',
    entityId: clipCandidate.id,
    actionUrl: buildProjectActionUrl(clipCandidate.contentPack.projectId),
    dedupeKey: buildNotificationDedupeKey({
      type: copy.type,
      entityId: clipCandidate.id,
      status: copy.outcome,
      eventAt: clipCandidate.updatedAt,
    }),
  });
}

export async function createClipPublicationPublishedNotification(
  clipPublicationId: number
) {
  const publication = await db.query.clipPublications.findFirst({
    where: eq(clipPublications.id, clipPublicationId),
    with: {
      renderedClip: {
        with: {
          contentPack: true,
          clipCandidate: true,
        },
      },
    },
  });

  if (!publication) {
    return;
  }

  const copy = buildClipPublicationPublishedNotificationCopy({
    clipTitle:
      publication.renderedClip.title || publication.renderedClip.clipCandidate.title,
    platform: publication.platform,
  });

  await createNotification({
    userId: publication.userId,
    type: copy.type,
    status: copy.outcome,
    title: copy.title,
    message: copy.message,
    entityType: 'clip_publication',
    entityId: publication.id,
    actionUrl:
      publication.platformUrl ||
      buildProjectActionUrl(publication.renderedClip.contentPack.projectId),
    dedupeKey: buildNotificationDedupeKey({
      type: copy.type,
      entityId: publication.id,
      status: copy.outcome,
      eventAt: publication.updatedAt,
    }),
  });
}

export async function createClipPublicationFailedNotification(
  clipPublicationId: number
) {
  const publication = await db.query.clipPublications.findFirst({
    where: eq(clipPublications.id, clipPublicationId),
    with: {
      renderedClip: {
        with: {
          contentPack: true,
          clipCandidate: true,
        },
      },
    },
  });

  if (!publication) {
    return;
  }

  const copy = buildClipPublicationFailedNotificationCopy({
    clipTitle:
      publication.renderedClip.title || publication.renderedClip.clipCandidate.title,
    platform: publication.platform,
    failureReason: publication.failureReason,
  });

  await createNotification({
    userId: publication.userId,
    type: copy.type,
    status: copy.outcome,
    title: copy.title,
    message: copy.message,
    entityType: 'clip_publication',
    entityId: publication.id,
    actionUrl: buildProjectActionUrl(publication.renderedClip.contentPack.projectId),
    dedupeKey: buildNotificationDedupeKey({
      type: copy.type,
      entityId: publication.id,
      status: copy.outcome,
      eventAt: publication.updatedAt,
    }),
  });
}
