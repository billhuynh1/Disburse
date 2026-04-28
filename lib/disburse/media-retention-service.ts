import 'server-only';

import { and, eq, inArray, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import {
  clipCandidates,
  ClipCandidateReviewStatus,
  MediaRetentionStatus,
  projects,
  renderedClips,
  RenderedClipStatus,
  sourceAssets,
  SourceAssetType,
  users,
  type RenderedClip,
  type SourceAsset,
} from '@/lib/db/schema';
import { deleteStorageObject } from '@/lib/disburse/s3-storage';

export const DEFAULT_USER_STORAGE_LIMIT_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_TEMPORARY_MEDIA_TTL_HOURS = 24;

type StorageBackedMedia = Pick<
  SourceAsset | RenderedClip,
  'retentionStatus' | 'storageDeletedAt'
>;

function getTemporaryMediaTtlHours() {
  const rawValue = process.env.TEMPORARY_MEDIA_TTL_HOURS?.trim();
  const parsedValue = rawValue ? Number(rawValue) : DEFAULT_TEMPORARY_MEDIA_TTL_HOURS;

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return DEFAULT_TEMPORARY_MEDIA_TTL_HOURS;
  }

  return parsedValue;
}

export function getTemporaryMediaExpiresAt(now = new Date()) {
  return new Date(now.getTime() + getTemporaryMediaTtlHours() * 60 * 60 * 1000);
}

export function isMediaUnavailable(media: StorageBackedMedia) {
  return (
    media.retentionStatus === MediaRetentionStatus.EXPIRED ||
    media.retentionStatus === MediaRetentionStatus.DELETED ||
    Boolean(media.storageDeletedAt)
  );
}

export function assertMediaAvailable(media: StorageBackedMedia, label: string) {
  if (isMediaUnavailable(media)) {
    throw new Error(`${label} is no longer available because its media expired.`);
  }
}

export async function getUserStorageUsageBytes(userId: number) {
  const [savedSourceAssets, savedRenderedClips] = await Promise.all([
    db.query.sourceAssets.findMany({
      columns: {
        fileSizeBytes: true,
      },
      where: and(
        eq(sourceAssets.userId, userId),
        eq(sourceAssets.retentionStatus, MediaRetentionStatus.SAVED),
        isNull(sourceAssets.storageDeletedAt)
      ),
    }),
    db.query.renderedClips.findMany({
      columns: {
        fileSizeBytes: true,
      },
      where: and(
        eq(renderedClips.userId, userId),
        eq(renderedClips.retentionStatus, MediaRetentionStatus.SAVED),
        isNull(renderedClips.storageDeletedAt)
      ),
    }),
  ]);

  return [...savedSourceAssets, ...savedRenderedClips].reduce(
    (total, item) => total + (item.fileSizeBytes || 0),
    0
  );
}

export async function getUserStorageLimitBytes(userId: number) {
  const user = await db.query.users.findFirst({
    columns: {
      storageLimitBytes: true,
    },
    where: eq(users.id, userId),
  });

  return user?.storageLimitBytes || DEFAULT_USER_STORAGE_LIMIT_BYTES;
}

export async function assertCanAddSavedStorage(userId: number, additionalBytes: number) {
  const [usedBytes, limitBytes] = await Promise.all([
    getUserStorageUsageBytes(userId),
    getUserStorageLimitBytes(userId),
  ]);

  if (usedBytes + additionalBytes > limitBytes) {
    throw new Error('Saving this media would exceed your storage limit.');
  }

  return {
    usedBytes,
    limitBytes,
    remainingBytes: Math.max(limitBytes - usedBytes - additionalBytes, 0),
  };
}

function savableSourceAssetWhere(projectId: number, userId: number) {
  return and(
    eq(sourceAssets.projectId, projectId),
    eq(sourceAssets.userId, userId),
    eq(sourceAssets.assetType, SourceAssetType.UPLOADED_FILE),
    isNotNull(sourceAssets.storageKey),
    isNull(sourceAssets.storageDeletedAt),
    or(
      isNull(sourceAssets.retentionStatus),
      eq(sourceAssets.retentionStatus, MediaRetentionStatus.TEMPORARY)
    )
  );
}

export async function saveProjectSourceMedia(projectId: number, userId: number) {
  const project = await db.query.projects.findFirst({
    columns: {
      id: true,
    },
    where: and(eq(projects.id, projectId), eq(projects.userId, userId)),
  });

  if (!project) {
    throw new Error('Project not found.');
  }

  const assets = await db.query.sourceAssets.findMany({
    columns: {
      id: true,
      fileSizeBytes: true,
    },
    where: savableSourceAssetWhere(projectId, userId),
  });
  const addedBytes = assets.reduce(
    (total, asset) => total + (asset.fileSizeBytes || 0),
    0
  );

  await assertCanAddSavedStorage(userId, addedBytes);

  const now = new Date();

  await db.transaction(async (tx) => {
    if (assets.length > 0) {
      await tx
        .update(sourceAssets)
        .set({
          retentionStatus: MediaRetentionStatus.SAVED,
          expiresAt: null,
          savedAt: now,
          deletionReason: null,
          updatedAt: now,
        })
        .where(savableSourceAssetWhere(projectId, userId));
    }

    await tx
      .update(projects)
      .set({
        savedAt: now,
        updatedAt: now,
      })
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
  });

  return {
    savedCount: assets.length,
    savedBytes: addedBytes,
  };
}

async function getSavableRenderedClipsForCandidate(
  clipCandidateId: number,
  userId: number
) {
  const clipCandidate = await db.query.clipCandidates.findFirst({
    columns: {
      id: true,
      reviewStatus: true,
      userId: true,
    },
    where: and(
      eq(clipCandidates.id, clipCandidateId),
      eq(clipCandidates.userId, userId)
    ),
    with: {
      renderedClips: true,
    },
  });

  if (!clipCandidate || clipCandidate.userId !== userId) {
    throw new Error('Clip candidate not found.');
  }

  if (clipCandidate.reviewStatus !== ClipCandidateReviewStatus.APPROVED) {
    throw new Error('Approve this clip before saving its rendered media.');
  }

  return clipCandidate.renderedClips.filter(
    (clip) =>
      clip.status === RenderedClipStatus.READY &&
      clip.storageKey &&
      !clip.storageDeletedAt &&
      clip.retentionStatus !== MediaRetentionStatus.SAVED &&
      clip.retentionStatus !== MediaRetentionStatus.EXPIRED &&
      clip.retentionStatus !== MediaRetentionStatus.DELETED
  );
}

export async function saveApprovedClipMedia(clipCandidateId: number, userId: number) {
  const clips = await getSavableRenderedClipsForCandidate(clipCandidateId, userId);

  if (clips.length === 0) {
    return {
      savedCount: 0,
      savedBytes: 0,
    };
  }

  const addedBytes = clips.reduce(
    (total, clip) => total + (clip.fileSizeBytes || 0),
    0
  );

  await assertCanAddSavedStorage(userId, addedBytes);

  const now = new Date();

  await db
    .update(renderedClips)
    .set({
      retentionStatus: MediaRetentionStatus.SAVED,
      expiresAt: null,
      savedAt: now,
      deletionReason: null,
      updatedAt: now,
    })
    .where(
      and(
        inArray(
          renderedClips.id,
          clips.map((clip) => clip.id)
        ),
        eq(renderedClips.userId, userId)
      )
    );

  return {
    savedCount: clips.length,
    savedBytes: addedBytes,
  };
}

export async function autoSaveApprovedClipMedia(
  clipCandidateId: number,
  userId: number
) {
  const user = await db.query.users.findFirst({
    columns: {
      autoSaveApprovedClipsEnabled: true,
    },
    where: eq(users.id, userId),
  });

  if (!user?.autoSaveApprovedClipsEnabled) {
    return {
      attempted: false,
      savedCount: 0,
      warning: null,
    };
  }

  try {
    const result = await saveApprovedClipMedia(clipCandidateId, userId);

    return {
      attempted: true,
      savedCount: result.savedCount,
      warning: null,
    };
  } catch (error) {
    return {
      attempted: true,
      savedCount: 0,
      warning:
        error instanceof Error
          ? error.message
          : 'Approved clip could not be auto-saved.',
    };
  }
}

async function cleanupSourceAsset(sourceAsset: Pick<SourceAsset, 'id' | 'storageKey'>) {
  if (sourceAsset.storageKey) {
    await deleteStorageObject(sourceAsset.storageKey);
  }

  const now = new Date();

  await db
    .update(sourceAssets)
    .set({
      retentionStatus: MediaRetentionStatus.EXPIRED,
      deletedAt: now,
      storageDeletedAt: now,
      deletionReason: 'Temporary media expired.',
      updatedAt: now,
    })
    .where(eq(sourceAssets.id, sourceAsset.id));
}

async function cleanupRenderedClip(renderedClip: Pick<RenderedClip, 'id' | 'storageKey'>) {
  if (renderedClip.storageKey) {
    await deleteStorageObject(renderedClip.storageKey);
  }

  const now = new Date();

  await db
    .update(renderedClips)
    .set({
      retentionStatus: MediaRetentionStatus.EXPIRED,
      deletedAt: now,
      storageDeletedAt: now,
      deletionReason: 'Temporary media expired.',
      updatedAt: now,
    })
    .where(eq(renderedClips.id, renderedClip.id));
}

export async function cleanupExpiredTemporaryMedia(now = new Date()) {
  const [expiredSourceAssets, expiredRenderedClips] = await Promise.all([
    db.query.sourceAssets.findMany({
      columns: {
        id: true,
        storageKey: true,
      },
      where: and(
        eq(sourceAssets.retentionStatus, MediaRetentionStatus.TEMPORARY),
        lte(sourceAssets.expiresAt, now),
        isNull(sourceAssets.savedAt),
        isNull(sourceAssets.storageDeletedAt)
      ),
    }),
    db.query.renderedClips.findMany({
      columns: {
        id: true,
        storageKey: true,
      },
      where: and(
        eq(renderedClips.retentionStatus, MediaRetentionStatus.TEMPORARY),
        lte(renderedClips.expiresAt, now),
        isNull(renderedClips.savedAt),
        isNull(renderedClips.storageDeletedAt)
      ),
    }),
  ]);

  const errors: string[] = [];
  let deletedSourceAssetCount = 0;
  let deletedRenderedClipCount = 0;

  for (const sourceAsset of expiredSourceAssets) {
    try {
      await cleanupSourceAsset(sourceAsset);
      deletedSourceAssetCount += 1;
    } catch (error) {
      errors.push(
        error instanceof Error
          ? `Source asset ${sourceAsset.id}: ${error.message}`
          : `Source asset ${sourceAsset.id}: cleanup failed.`
      );
    }
  }

  for (const renderedClip of expiredRenderedClips) {
    try {
      await cleanupRenderedClip(renderedClip);
      deletedRenderedClipCount += 1;
    } catch (error) {
      errors.push(
        error instanceof Error
          ? `Rendered clip ${renderedClip.id}: ${error.message}`
          : `Rendered clip ${renderedClip.id}: cleanup failed.`
      );
    }
  }

  return {
    deletedSourceAssetCount,
    deletedRenderedClipCount,
    errorCount: errors.length,
    errors,
  };
}
