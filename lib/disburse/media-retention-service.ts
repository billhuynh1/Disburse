import 'server-only';

import { and, eq, inArray, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import {
  clipCandidateFacecamDetections,
  clipCandidates,
  ClipCandidateReviewStatus,
  contentPacks,
  generatedAssets,
  jobs,
  JobStatus,
  JobType,
  MediaRetentionStatus,
  projects,
  renderedClips,
  RenderedClipStatus,
  sourceAssets,
  SourceAssetType,
  transcripts,
  transcriptSegments,
  transcriptWords,
  users,
  type RenderedClip,
  type SourceAsset,
} from '@/lib/db/schema';
import { deleteStorageObject } from '@/lib/disburse/s3-storage';

export const DEFAULT_USER_STORAGE_LIMIT_BYTES = 100 * 1024 * 1024 * 1024;
const DEFAULT_TEMPORARY_PROJECT_TTL_HOURS = 168;

type StorageBackedMedia = Pick<
  SourceAsset | RenderedClip,
  'retentionStatus' | 'storageDeletedAt'
>;

function getTemporaryProjectTtlHours() {
  const rawValue =
    process.env.TEMPORARY_PROJECT_TTL_HOURS?.trim() ||
    process.env.TEMPORARY_MEDIA_TTL_HOURS?.trim();
  const parsedValue = rawValue
    ? Number(rawValue)
    : DEFAULT_TEMPORARY_PROJECT_TTL_HOURS;

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return DEFAULT_TEMPORARY_PROJECT_TTL_HOURS;
  }

  return parsedValue;
}

export function getTemporaryProjectExpiresAt(now = new Date()) {
  return new Date(now.getTime() + getTemporaryProjectTtlHours() * 60 * 60 * 1000);
}

export function getTemporaryMediaExpiresAt(now = new Date()) {
  return getTemporaryProjectExpiresAt(now);
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

function savableRenderedClipWhere(projectId: number, userId: number) {
  return and(
    eq(renderedClips.userId, userId),
    isNotNull(renderedClips.storageKey),
    isNull(renderedClips.storageDeletedAt),
    or(
      isNull(renderedClips.retentionStatus),
      eq(renderedClips.retentionStatus, MediaRetentionStatus.TEMPORARY)
    ),
    inArray(
      renderedClips.contentPackId,
      db
        .select({ id: contentPacks.id })
        .from(contentPacks)
        .where(and(eq(contentPacks.projectId, projectId), eq(contentPacks.userId, userId)))
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

  const [assets, clips] = await Promise.all([
    db.query.sourceAssets.findMany({
      columns: {
        id: true,
        fileSizeBytes: true,
      },
      where: savableSourceAssetWhere(projectId, userId),
    }),
    db
      .select({
        id: renderedClips.id,
        fileSizeBytes: renderedClips.fileSizeBytes,
      })
      .from(renderedClips)
      .innerJoin(contentPacks, eq(renderedClips.contentPackId, contentPacks.id))
      .where(
        and(
          eq(contentPacks.projectId, projectId),
          eq(contentPacks.userId, userId),
          eq(renderedClips.userId, userId),
          isNotNull(renderedClips.storageKey),
          isNull(renderedClips.storageDeletedAt),
          or(
            isNull(renderedClips.retentionStatus),
            eq(renderedClips.retentionStatus, MediaRetentionStatus.TEMPORARY)
          )
        )
      ),
  ]);
  const addedBytes = [...assets, ...clips].reduce(
    (total, item) => total + (item.fileSizeBytes || 0),
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

    if (clips.length > 0) {
      await tx
        .update(renderedClips)
        .set({
          retentionStatus: MediaRetentionStatus.SAVED,
          expiresAt: null,
          savedAt: now,
          deletionReason: null,
          updatedAt: now,
        })
        .where(savableRenderedClipWhere(projectId, userId));
    }

    await tx
      .update(projects)
      .set({
        isSaved: true,
        expiresAt: null,
        savedAt: now,
        updatedAt: now,
      })
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
  });

  return {
    savedCount: assets.length + clips.length,
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

function getRelatedProjectJobIds(params: {
  jobs: Array<{ id: number; status: string; payload: unknown }>;
  projectId: number;
  sourceAssetIds: number[];
  contentPackIds: number[];
  clipCandidateIds: number[];
}) {
  return params.jobs
    .filter((job) => {
      const payload = job.payload;

      if (!payload || typeof payload !== 'object') {
        return false;
      }

      return (
        ('projectId' in payload &&
          typeof payload.projectId === 'number' &&
          payload.projectId === params.projectId) ||
        ('sourceAssetId' in payload &&
          typeof payload.sourceAssetId === 'number' &&
          params.sourceAssetIds.includes(payload.sourceAssetId)) ||
        ('contentPackId' in payload &&
          typeof payload.contentPackId === 'number' &&
          params.contentPackIds.includes(payload.contentPackId)) ||
        ('clipCandidateId' in payload &&
          typeof payload.clipCandidateId === 'number' &&
          params.clipCandidateIds.includes(payload.clipCandidateId))
      );
    })
    .map((job) => ({ id: job.id, status: job.status }));
}

export async function deleteProjectGraph(params: {
  projectId: number;
  userId?: number;
  blockProcessingJobs?: boolean;
}) {
  const project = await db.query.projects.findFirst({
    where: params.userId
      ? and(eq(projects.id, params.projectId), eq(projects.userId, params.userId))
      : eq(projects.id, params.projectId),
    with: {
      sourceAssets: {
        with: {
          transcript: true,
        },
      },
      contentPacks: {
        with: {
          clipCandidates: {
            with: {
              renderedClips: true,
              facecamDetections: true,
            },
          },
          renderedClips: true,
          generatedAssets: true,
        },
      },
    },
  });

  if (!project) {
    return {
      deleted: false,
      deletedStorageObjectCount: 0,
    };
  }

  const sourceAssetIds = project.sourceAssets.map((asset) => asset.id);
  const contentPackIds = project.contentPacks.map((pack) => pack.id);
  const clipCandidateIds = project.contentPacks.flatMap((pack) =>
    pack.clipCandidates.map((candidate) => candidate.id)
  );
  const transcriptIds = project.sourceAssets
    .map((asset) => asset.transcript?.id || null)
    .filter((value): value is number => Boolean(value));
  const allJobs = await db.query.jobs.findMany({
    where: inArray(jobs.type, [
      JobType.TRANSCRIBE_SOURCE_ASSET,
      JobType.INGEST_YOUTUBE_SOURCE_ASSET,
      JobType.GENERATE_SHORT_FORM_PACK,
      JobType.RENDER_CLIP_CANDIDATE,
      JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
      JobType.DETECT_CLIP_FACECAM,
    ]),
  });
  const relatedJobIds = getRelatedProjectJobIds({
    jobs: allJobs,
    projectId: project.id,
    sourceAssetIds,
    contentPackIds,
    clipCandidateIds,
  });

  if (
    params.blockProcessingJobs !== false &&
    relatedJobIds.some((job) => job.status === JobStatus.PROCESSING)
  ) {
    throw new Error(
      'This project is currently being processed. Wait for background jobs to finish before deleting it.'
    );
  }

  const storageKeys = Array.from(
    new Set(
      [
        ...project.sourceAssets
          .filter((asset) => asset.assetType === SourceAssetType.UPLOADED_FILE)
          .map((asset) => asset.storageKey),
        ...project.contentPacks.flatMap((pack) => [
          ...pack.renderedClips.map((clip) => clip.storageKey),
          ...pack.clipCandidates.flatMap((candidate) =>
            candidate.renderedClips.map((clip) => clip.storageKey)
          ),
        ]),
      ].filter((value): value is string => Boolean(value))
    )
  );

  await Promise.all(storageKeys.map((storageKey) => deleteStorageObject(storageKey)));

  await db.transaction(async (tx) => {
    if (relatedJobIds.length > 0) {
      await tx.delete(jobs).where(
        inArray(
          jobs.id,
          relatedJobIds.map((job) => job.id)
        )
      );
    }

    if (clipCandidateIds.length > 0) {
      await tx
        .delete(clipCandidateFacecamDetections)
        .where(inArray(clipCandidateFacecamDetections.clipCandidateId, clipCandidateIds));

      await tx
        .delete(renderedClips)
        .where(inArray(renderedClips.clipCandidateId, clipCandidateIds));

      await tx.delete(clipCandidates).where(inArray(clipCandidates.id, clipCandidateIds));
    }

    if (contentPackIds.length > 0) {
      await tx
        .delete(generatedAssets)
        .where(inArray(generatedAssets.contentPackId, contentPackIds));

      await tx
        .delete(renderedClips)
        .where(inArray(renderedClips.contentPackId, contentPackIds));

      await tx.delete(contentPacks).where(inArray(contentPacks.id, contentPackIds));
    }

    if (transcriptIds.length > 0) {
      await tx
        .delete(transcriptSegments)
        .where(inArray(transcriptSegments.transcriptId, transcriptIds));
      await tx
        .delete(transcriptWords)
        .where(inArray(transcriptWords.transcriptId, transcriptIds));

      await tx.delete(transcripts).where(inArray(transcripts.id, transcriptIds));
    }

    if (sourceAssetIds.length > 0) {
      await tx.delete(sourceAssets).where(inArray(sourceAssets.id, sourceAssetIds));
    }

    await tx.delete(projects).where(eq(projects.id, project.id));
  });

  return {
    deleted: true,
    deletedStorageObjectCount: storageKeys.length,
  };
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
  const expiredProjects = await db.query.projects.findMany({
    columns: {
      id: true,
    },
    where: and(
      eq(projects.isSaved, false),
      lte(projects.expiresAt, now)
    ),
  });
  const cleanedProjectIds: number[] = [];
  const errors: string[] = [];

  for (const project of expiredProjects) {
    try {
      const result = await deleteProjectGraph({
        projectId: project.id,
        blockProcessingJobs: false,
      });

      if (result.deleted) {
        cleanedProjectIds.push(project.id);
      }
    } catch (error) {
      errors.push(
        error instanceof Error
          ? `Project ${project.id}: ${error.message}`
          : `Project ${project.id}: cleanup failed.`
      );
    }
  }

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
    deletedProjectCount: cleanedProjectIds.length,
    deletedSourceAssetCount,
    deletedRenderedClipCount,
    errorCount: errors.length,
    errors,
  };
}
