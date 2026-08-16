import 'server-only';
import { emitOperationalEvent } from '@/lib/disburse/operational-events';
import { getOperationalCorrelation } from '@/lib/disburse/operational-context';

import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import {
  clipCandidateFacecamDetectionRuns,
  clipCandidateFacecamDetections,
  clipCandidates,
  clipEditConfigs,
  clipRenderConfigs,
  contentPacks,
  facecamSegments,
  generatedAssets,
  jobs,
  JobStatus,
  JobType,
  JobFailureClass,
  MediaRetentionStatus,
  projects,
  clipPublications,
  renderedClips,
  RenderedClipStatus,
  sourceAssets,
  sourceAssetThumbnailVariants,
  sourceUploadParts,
  sourceUploadSessions,
  SourceUploadSessionStatus,
  SourceAssetType,
  transcripts,
  transcriptSegments,
  transcriptWords,
  users,
  type RenderedClip,
  type SourceAsset,
} from '@/lib/db/schema';
import { getRelatedProjectJobIds } from '@/lib/disburse/project-job-relations';
import {
  abortMultipartUpload as abortStorageMultipartUpload,
  deleteStorageObject,
  getDeterministicSourceAssetThumbnailStorageKeys,
} from '@/lib/disburse/s3-storage';
import { StaleJobReason } from '@/lib/disburse/stale-job';
import { classifyShortFormGenerationMode } from '@/lib/disburse/short-form-generation-mode-service';

const BYTES_PER_GB = 1024 * 1024 * 1024;
const FALLBACK_USER_STORAGE_LIMIT_GB = 50;
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

function getDefaultUserStorageLimitBytes() {
  const rawValue = process.env.DEFAULT_USER_STORAGE_LIMIT_GB?.trim();
  const parsedValue = rawValue ? Number(rawValue) : FALLBACK_USER_STORAGE_LIMIT_GB;

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return FALLBACK_USER_STORAGE_LIMIT_GB * BYTES_PER_GB;
  }

  return Math.round(parsedValue * BYTES_PER_GB);
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

export async function getUserActiveStorageUsageBytes(userId: number) {
  const [sourceAssetMedia, renderedClipMedia] = await Promise.all([
    db.query.sourceAssets.findMany({
      columns: {
        fileSizeBytes: true,
      },
      where: and(
        eq(sourceAssets.userId, userId),
        isNull(sourceAssets.storageDeletedAt)
      ),
    }),
    db.query.renderedClips.findMany({
      columns: {
        fileSizeBytes: true,
      },
      where: and(
        eq(renderedClips.userId, userId),
        isNull(renderedClips.storageDeletedAt)
      ),
    }),
  ]);

  return [...sourceAssetMedia, ...renderedClipMedia].reduce(
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

  return user?.storageLimitBytes || getDefaultUserStorageLimitBytes();
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

  return saveRenderedClipMedia(clips, userId);
}

async function saveRenderedClipMedia(
  clips: Awaited<ReturnType<typeof getSavableRenderedClipsForCandidate>>,
  userId: number
) {

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

export async function saveCurrentRenderedClipMedia(
  params: {
    clipCandidateId: number;
    renderedClipId: number;
    renderConfigId?: number;
  },
  userId: number
) {
  const renderedClip = await db.query.renderedClips.findFirst({
    where: and(
      eq(renderedClips.id, params.renderedClipId),
      eq(renderedClips.clipCandidateId, params.clipCandidateId),
      eq(renderedClips.userId, userId)
    ),
    with: {
      clipCandidate: {
        columns: {
          contentPackId: true,
          currentRenderConfigId: true,
          generationRunId: true,
        },
      },
    },
  });

  if (!renderedClip?.clipCandidate) {
    throw new Error('Rendered clip not found.');
  }

  const generationMode = await classifyShortFormGenerationMode({
    contentPackId: renderedClip.clipCandidate.contentPackId,
    generationRunId: renderedClip.clipCandidate.generationRunId,
  });

  if (generationMode.kind === 'invalid_snapshot_reference') {
    throw new Error(generationMode.code);
  }

  if (generationMode.kind === 'legacy') {
    return saveApprovedClipMedia(params.clipCandidateId, userId);
  }

  if (
    !renderedClip.clipRenderConfigId ||
    params.renderConfigId !== renderedClip.clipRenderConfigId ||
    renderedClip.clipCandidate.currentRenderConfigId !== renderedClip.clipRenderConfigId
  ) {
    throw new Error('rendered_clip_not_current');
  }

  const savableClips = [renderedClip].filter(
    (clip) =>
      clip.status === RenderedClipStatus.READY &&
      clip.storageKey &&
      !clip.storageDeletedAt &&
      clip.retentionStatus !== MediaRetentionStatus.SAVED &&
      clip.retentionStatus !== MediaRetentionStatus.EXPIRED &&
      clip.retentionStatus !== MediaRetentionStatus.DELETED
  );

  return saveRenderedClipMedia(savableClips, userId);
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
          : 'Clip could not be auto-saved.',
    };
  }
}

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DeletionStorage = (storageKey: string) => Promise<void>;
type DeletionMultipartAbort = (params: {
  storageKey: string;
  uploadId: string;
}) => Promise<void>;

function emitDeletionState(fields: Record<string, unknown>) {
  emitOperationalEvent('pipeline.deletion_state', {
    ...getOperationalCorrelation(),
    ...fields,
  });
}

const ALL_JOB_TYPES = Object.values(JobType);

async function loadProjectDeletionGraph(
  executor: typeof db | DbTransaction,
  projectId: number,
  userId?: number
) {
  const project = await executor.query.projects.findFirst({
    where: userId
      ? and(eq(projects.id, projectId), eq(projects.userId, userId))
      : eq(projects.id, projectId),
    with: {
      sourceAssets: {
        with: {
          thumbnailVariants: true,
          transcript: true,
        },
      },
      contentPacks: {
        with: {
          clipCandidates: {
            with: {
              renderedClips: true,
            },
          },
          renderedClips: true,
          generatedAssets: true,
        },
      },
    },
});

  if (!project) return null;

  const sourceAssetIds = project.sourceAssets.map((asset) => asset.id);
  const contentPackIds = project.contentPacks.map((pack) => pack.id);
  const clipCandidateIds = project.contentPacks.flatMap((pack) =>
    pack.clipCandidates.map((candidate) => candidate.id)
  );
  const transcriptIds = project.sourceAssets
    .map((asset) => asset.transcript?.id || null)
    .filter((value): value is number => Boolean(value));
  const renderedClipIds = Array.from(new Set(project.contentPacks.flatMap((pack) => [
    ...pack.renderedClips.map((clip) => clip.id),
    ...pack.clipCandidates.flatMap((candidate) =>
      candidate.renderedClips.map((clip) => clip.id)
    ),
  ])));
  const publications = renderedClipIds.length > 0
    ? await executor.select({ id: clipPublications.id })
        .from(clipPublications)
        .where(inArray(clipPublications.renderedClipId, renderedClipIds))
    : [];
  const clipPublicationIds = publications.map((publication) => publication.id);
  const uploadSessions = await executor
    .select({
      storageKey: sourceUploadSessions.storageKey,
      uploadId: sourceUploadSessions.uploadId,
      status: sourceUploadSessions.status,
    })
    .from(sourceUploadSessions)
    .where(eq(sourceUploadSessions.projectId, project.id));
  const jobRelationFilters = [
    sql<boolean>`${jobs.payload}->>'projectId' = ${String(project.id)}`,
    sourceAssetIds.length > 0
      ? sql<boolean>`${jobs.payload}->>'sourceAssetId' in (${sql.join(sourceAssetIds.map((id) => sql`${String(id)}`), sql`, `)})`
      : null,
    contentPackIds.length > 0
      ? sql<boolean>`${jobs.payload}->>'contentPackId' in (${sql.join(contentPackIds.map((id) => sql`${String(id)}`), sql`, `)})`
      : null,
    clipCandidateIds.length > 0
      ? sql<boolean>`${jobs.payload}->>'clipCandidateId' in (${sql.join(clipCandidateIds.map((id) => sql`${String(id)}`), sql`, `)})`
      : null,
    renderedClipIds.length > 0
      ? sql<boolean>`${jobs.payload}->>'renderedClipId' in (${sql.join(renderedClipIds.map((id) => sql`${String(id)}`), sql`, `)})`
      : null,
    clipPublicationIds.length > 0
      ? sql<boolean>`${jobs.payload}->>'clipPublicationId' in (${sql.join(clipPublicationIds.map((id) => sql`${String(id)}`), sql`, `)})`
      : null,
  ].filter((filter): filter is Exclude<typeof filter, null> => Boolean(filter));
  const allJobs = await executor.query.jobs.findMany({
    where: and(inArray(jobs.type, ALL_JOB_TYPES), or(...jobRelationFilters)),
  });
  const relatedJobIds = getRelatedProjectJobIds({
    jobs: allJobs,
    projectId: project.id,
    sourceAssetIds,
    contentPackIds,
    clipCandidateIds,
    renderedClipIds,
    clipPublicationIds,
  });

  const storageKeys = Array.from(
    new Set(
      [
        ...project.sourceAssets.flatMap((asset) => [
            asset.storageKey,
            asset.thumbnailStorageKey,
            ...asset.thumbnailVariants.map((variant) => variant.storageKey),
            ...getDeterministicSourceAssetThumbnailStorageKeys({
              userId: asset.userId,
              projectId: asset.projectId,
              sourceAssetId: asset.id,
            }),
          ]),
        ...uploadSessions.map((session) => session.storageKey),
        ...project.contentPacks.flatMap((pack) => [
          ...pack.renderedClips.map((clip) => clip.storageKey),
          ...pack.clipCandidates.flatMap((candidate) =>
            candidate.renderedClips.map((clip) => clip.storageKey)
          ),
        ]),
      ].filter((value): value is string => Boolean(value))
    )
  );

  return {
    project,
    sourceAssetIds,
    contentPackIds,
    clipCandidateIds,
    transcriptIds,
    renderedClipIds,
    clipPublicationIds,
    relatedJobIds,
    storageKeys,
    multipartUploads: uploadSessions
      .filter((session) => [
        SourceUploadSessionStatus.UPLOADING,
        SourceUploadSessionStatus.FAILED,
      ].includes(session.status as SourceUploadSessionStatus))
      .map((session) => ({
        storageKey: session.storageKey,
        uploadId: session.uploadId,
      })),
    hasCompletingUpload: uploadSessions.some(
      (session) => session.status === SourceUploadSessionStatus.COMPLETING
    ),
  };
}

async function lockProjectDeletionGraph(
  tx: DbTransaction,
  projectId: number,
  userId?: number
) {
  const [project] = await tx.select({
    id: projects.id,
    deletionRequestedAt: projects.deletionRequestedAt,
  })
    .from(projects)
    .where(userId
      ? and(eq(projects.id, projectId), eq(projects.userId, userId))
      : eq(projects.id, projectId))
    .for('update')
    .limit(1);
  if (!project) return null;

  await tx.select({ id: sourceAssets.id }).from(sourceAssets)
    .where(eq(sourceAssets.projectId, projectId)).orderBy(sourceAssets.id).for('update');
  await tx.select({ id: contentPacks.id }).from(contentPacks)
    .where(eq(contentPacks.projectId, projectId)).orderBy(contentPacks.id).for('update');

  const graph = await loadProjectDeletionGraph(tx, projectId, userId);
  if (!graph) return null;

  if (graph.clipCandidateIds.length > 0) {
    await tx.select({ id: clipCandidates.id }).from(clipCandidates)
      .where(inArray(clipCandidates.id, graph.clipCandidateIds))
      .orderBy(clipCandidates.id).for('update');
  }
  if (graph.renderedClipIds.length > 0) {
    await tx.select({ id: renderedClips.id }).from(renderedClips)
      .where(inArray(renderedClips.id, graph.renderedClipIds))
      .orderBy(renderedClips.id).for('update');
  }
  if (graph.clipPublicationIds.length > 0) {
    await tx.select({ id: clipPublications.id }).from(clipPublications)
      .where(inArray(clipPublications.id, graph.clipPublicationIds))
      .orderBy(clipPublications.id).for('update');
  }
  if (graph.relatedJobIds.length > 0) {
    await tx.select({ id: jobs.id }).from(jobs)
      .where(inArray(jobs.id, graph.relatedJobIds.map((job) => job.id)))
      .orderBy(jobs.id).for('update');
  }

  return graph;
}

async function requestCancellationForJobs(
  tx: DbTransaction,
  jobIds: number[],
  reason: StaleJobReason
) {
  if (jobIds.length === 0) return;
  const now = sql<Date>`clock_timestamp()`;

  await tx.update(jobs).set({
    status: JobStatus.CANCELLED,
    completedAt: now,
    cancellationRequestedAt: now,
    cancellationReason: reason,
    failureReason: `Cancelled: ${reason}`,
    failureCode: reason,
    failureClass: JobFailureClass.CANCELLED,
    leaseToken: null,
    leaseExpiresAt: null,
    heartbeatAt: now,
    updatedAt: now,
  }).where(and(
    inArray(jobs.id, jobIds),
    eq(jobs.status, JobStatus.PENDING)
  ));

  await tx.update(jobs).set({
    cancellationRequestedAt: now,
    cancellationReason: reason,
    updatedAt: now,
  }).where(and(
    inArray(jobs.id, jobIds),
    eq(jobs.status, JobStatus.PROCESSING)
  ));

  await tx.update(jobs).set({
    status: JobStatus.CANCELLED,
    completedAt: now,
    failureReason: `Cancelled: ${reason}`,
    failureCode: reason,
    failureClass: JobFailureClass.CANCELLED,
    leaseToken: null,
    leaseExpiresAt: null,
    heartbeatAt: now,
    updatedAt: now,
  }).where(and(
    inArray(jobs.id, jobIds),
    eq(jobs.status, JobStatus.PROCESSING),
    or(isNull(jobs.leaseExpiresAt), lte(jobs.leaseExpiresAt, now))
  ));
}

async function hasActiveDeletionLease(tx: DbTransaction, jobIds: number[]) {
  if (jobIds.length === 0) return false;
  const [activeJob] = await tx.select({ id: jobs.id }).from(jobs).where(and(
    inArray(jobs.id, jobIds),
    eq(jobs.status, JobStatus.PROCESSING),
    sql<boolean>`${jobs.leaseExpiresAt} > clock_timestamp()`
  )).limit(1);
  return Boolean(activeJob);
}

async function deleteProjectDatabaseGraph(
  tx: DbTransaction,
  graph: NonNullable<Awaited<ReturnType<typeof loadProjectDeletionGraph>>>
) {
  const {
    project,
    sourceAssetIds,
    contentPackIds,
    clipCandidateIds,
    transcriptIds,
    renderedClipIds,
  } = graph;

  if (renderedClipIds.length > 0) {
    await tx.delete(clipPublications)
      .where(inArray(clipPublications.renderedClipId, renderedClipIds));
  }

  if (clipCandidateIds.length > 0) {
    await tx.delete(renderedClips)
      .where(inArray(renderedClips.clipCandidateId, clipCandidateIds));
    await tx.delete(clipEditConfigs)
      .where(inArray(clipEditConfigs.clipCandidateId, clipCandidateIds));
    await tx.delete(clipRenderConfigs)
      .where(inArray(clipRenderConfigs.clipCandidateId, clipCandidateIds));
    await tx.delete(clipCandidateFacecamDetections)
      .where(inArray(clipCandidateFacecamDetections.clipCandidateId, clipCandidateIds));
    await tx.delete(clipCandidateFacecamDetectionRuns)
      .where(inArray(clipCandidateFacecamDetectionRuns.clipCandidateId, clipCandidateIds));
    await tx.delete(clipCandidates).where(inArray(clipCandidates.id, clipCandidateIds));
  }

  if (contentPackIds.length > 0) {
    await tx.delete(generatedAssets)
      .where(inArray(generatedAssets.contentPackId, contentPackIds));
    await tx.delete(renderedClips)
      .where(inArray(renderedClips.contentPackId, contentPackIds));
    await tx.delete(clipEditConfigs)
      .where(inArray(clipEditConfigs.contentPackId, contentPackIds));
    await tx.delete(clipRenderConfigs)
      .where(inArray(clipRenderConfigs.contentPackId, contentPackIds));
    await tx.delete(clipCandidateFacecamDetectionRuns)
      .where(inArray(clipCandidateFacecamDetectionRuns.contentPackId, contentPackIds));
    await tx.delete(contentPacks).where(inArray(contentPacks.id, contentPackIds));
  }

  if (sourceAssetIds.length > 0) {
    await tx.delete(facecamSegments).where(inArray(facecamSegments.videoId, sourceAssetIds));
    await tx.delete(renderedClips).where(inArray(renderedClips.sourceAssetId, sourceAssetIds));
    await tx.delete(clipRenderConfigs).where(inArray(clipRenderConfigs.sourceAssetId, sourceAssetIds));
    await tx.delete(clipEditConfigs).where(inArray(clipEditConfigs.sourceAssetId, sourceAssetIds));
    await tx.delete(clipCandidateFacecamDetections)
      .where(inArray(clipCandidateFacecamDetections.sourceAssetId, sourceAssetIds));
    await tx.delete(clipCandidateFacecamDetectionRuns)
      .where(inArray(clipCandidateFacecamDetectionRuns.sourceAssetId, sourceAssetIds));
  }

  if (transcriptIds.length > 0) {
    await tx.delete(transcriptSegments).where(inArray(transcriptSegments.transcriptId, transcriptIds));
    await tx.delete(transcriptWords).where(inArray(transcriptWords.transcriptId, transcriptIds));
    await tx.delete(transcripts).where(inArray(transcripts.id, transcriptIds));
  }

  const uploadSessionIds = (await tx.select({ id: sourceUploadSessions.id })
    .from(sourceUploadSessions).where(eq(sourceUploadSessions.projectId, project.id)))
    .map((session) => session.id);
  if (uploadSessionIds.length > 0) {
    await tx.delete(sourceUploadParts)
      .where(inArray(sourceUploadParts.uploadSessionId, uploadSessionIds));
    await tx.delete(sourceUploadSessions)
      .where(inArray(sourceUploadSessions.id, uploadSessionIds));
  }

  if (sourceAssetIds.length > 0) {
    await tx.delete(sourceAssetThumbnailVariants)
      .where(inArray(sourceAssetThumbnailVariants.sourceAssetId, sourceAssetIds));
    await tx.delete(sourceAssets).where(inArray(sourceAssets.id, sourceAssetIds));
  }

  await tx.delete(projects).where(eq(projects.id, project.id));
}

export async function deleteProjectGraph(params: {
  projectId: number;
  userId?: number;
  deleteStorageObject?: DeletionStorage;
  abortMultipartUpload?: DeletionMultipartAbort;
}) {
  const requestedGraph = await db.transaction(async (tx) => {
    const graph = await lockProjectDeletionGraph(tx, params.projectId, params.userId);
    if (!graph) return null;
    const now = sql<Date>`clock_timestamp()`;
    await tx.update(projects).set({ deletionRequestedAt: now, updatedAt: now })
      .where(eq(projects.id, graph.project.id));
    await requestCancellationForJobs(
      tx,
      graph.relatedJobIds.map((job) => job.id),
      StaleJobReason.PROJECT_DELETED
    );
    return graph;
  });

  if (!requestedGraph) {
    emitDeletionState({ projectId: params.projectId, deletionState: 'not_found' });
    return { deleted: false, pending: false, deletedStorageObjectCount: 0 };
  }
  emitDeletionState({ projectId: params.projectId, deletionState: 'requested' });

  const readiness = await db.transaction(async (tx) => {
    const graph = await lockProjectDeletionGraph(tx, params.projectId, params.userId);
    if (!graph) return { graph: null, ready: false };
    if (!graph.project.deletionRequestedAt) return { graph, ready: false };
    await requestCancellationForJobs(
      tx,
      graph.relatedJobIds.map((job) => job.id),
      StaleJobReason.PROJECT_DELETED
    );
    const activeLease = await hasActiveDeletionLease(
      tx,
      graph.relatedJobIds.map((job) => job.id)
    );
    return {
      graph,
      ready: !activeLease && !graph.hasCompletingUpload,
    };
  });

  if (!readiness.graph || !readiness.ready) {
    emitDeletionState({ projectId: params.projectId, deletionState: 'waiting_for_leases' });
    return { deleted: false, pending: true, deletedStorageObjectCount: 0 };
  }

  const abortMultipart = params.abortMultipartUpload ?? abortStorageMultipartUpload;
  await Promise.all(readiness.graph.multipartUploads.map(abortMultipart));
  const removeStorageObject = params.deleteStorageObject ?? deleteStorageObject;
  await Promise.all(readiness.graph.storageKeys.map(removeStorageObject));

  const finalized = await db.transaction(async (tx) => {
    const graph = await lockProjectDeletionGraph(tx, params.projectId, params.userId);
    if (!graph || !graph.project.deletionRequestedAt) return false;
    await requestCancellationForJobs(
      tx,
      graph.relatedJobIds.map((job) => job.id),
      StaleJobReason.PROJECT_DELETED
    );
    if (await hasActiveDeletionLease(tx, graph.relatedJobIds.map((job) => job.id))) {
      throw new Error('Project deletion is waiting for active job leases to stop.');
    }
    if (graph.hasCompletingUpload) {
      throw new Error('Project deletion is waiting for upload completion to stop.');
    }
    if (!graph.project.deletionRequestedAt) return false;
    await deleteProjectDatabaseGraph(tx, graph);
    return true;
  });

  const result = {
    deleted: finalized,
    pending: false,
    deletedStorageObjectCount: finalized ? readiness.graph.storageKeys.length : 0,
  };
  emitDeletionState({
    projectId: params.projectId,
    deletionState: finalized ? 'finalized' : 'finalization_lost',
    deletedObjects: result.deletedStorageObjectCount,
  });
  return result;
}

async function lockSourceDeletionGraph(
  tx: DbTransaction,
  projectId: number,
  sourceAssetId: number,
  userId: number
) {
  const [project] = await tx.select({
    id: projects.id,
    deletionRequestedAt: projects.deletionRequestedAt,
  })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .for('update').limit(1);
  if (!project) return null;
  if (project.deletionRequestedAt) {
    throw new Error('Project deletion is already handling this source asset.');
  }

  const [sourceAsset] = await tx.select().from(sourceAssets)
    .where(and(
      eq(sourceAssets.id, sourceAssetId),
      eq(sourceAssets.projectId, projectId),
      eq(sourceAssets.userId, userId)
    ))
    .for('update').limit(1);
  if (!sourceAsset) return null;

  const packs = await tx.select({ id: contentPacks.id }).from(contentPacks)
    .where(eq(contentPacks.sourceAssetId, sourceAssetId))
    .orderBy(contentPacks.id).for('update');
  if (packs.length > 0) {
    throw new Error(
      'This source asset is linked to one or more content packs. Remove those content packs before deleting the asset.'
    );
  }

  const thumbnailVariants = await tx.select({ storageKey: sourceAssetThumbnailVariants.storageKey })
    .from(sourceAssetThumbnailVariants)
    .where(eq(sourceAssetThumbnailVariants.sourceAssetId, sourceAssetId));
  const [transcript] = await tx.select({ id: transcripts.id }).from(transcripts)
    .where(eq(transcripts.sourceAssetId, sourceAssetId)).limit(1);
  const uploadSessions = await tx.select({
    id: sourceUploadSessions.id,
    storageKey: sourceUploadSessions.storageKey,
    uploadId: sourceUploadSessions.uploadId,
    status: sourceUploadSessions.status,
  })
    .from(sourceUploadSessions)
    .where(and(
      eq(sourceUploadSessions.projectId, projectId),
      eq(sourceUploadSessions.userId, userId),
      or(
        eq(sourceUploadSessions.sourceAssetId, sourceAssetId),
        ...(sourceAsset.storageKey
          ? [eq(sourceUploadSessions.storageKey, sourceAsset.storageKey)]
          : [])
      )
    ))
    .orderBy(sourceUploadSessions.id)
    .for('update');
  const allJobs = await tx.query.jobs.findMany({
    where: and(
      inArray(jobs.type, ALL_JOB_TYPES),
      sql<boolean>`${jobs.payload}->>'sourceAssetId' = ${String(sourceAssetId)}`
    ),
  });
  const relatedJobs = getRelatedProjectJobIds({
    jobs: allJobs,
    projectId: -1,
    sourceAssetIds: [sourceAssetId],
    contentPackIds: [],
    clipCandidateIds: [],
    renderedClipIds: [],
    clipPublicationIds: [],
  });
  if (relatedJobs.length > 0) {
    await tx.select({ id: jobs.id }).from(jobs)
      .where(inArray(jobs.id, relatedJobs.map((job) => job.id)))
      .orderBy(jobs.id).for('update');
  }

  return {
    sourceAsset,
    transcriptId: transcript?.id ?? null,
    uploadSessionIds: uploadSessions.map((session) => session.id),
    multipartUploads: uploadSessions
      .filter((session) => [
        SourceUploadSessionStatus.UPLOADING,
        SourceUploadSessionStatus.FAILED,
      ].includes(session.status as SourceUploadSessionStatus))
      .map((session) => ({
        storageKey: session.storageKey,
        uploadId: session.uploadId,
      })),
    hasCompletingUpload: uploadSessions.some(
      (session) => session.status === SourceUploadSessionStatus.COMPLETING
    ),
    relatedJobs,
    storageKeys: Array.from(new Set([
      sourceAsset.storageKey,
      sourceAsset.thumbnailStorageKey,
      ...thumbnailVariants.map((variant) => variant.storageKey),
      ...getDeterministicSourceAssetThumbnailStorageKeys({
        userId: sourceAsset.userId,
        projectId: sourceAsset.projectId,
        sourceAssetId: sourceAsset.id,
      }),
      ...uploadSessions.map((session) => session.storageKey),
    ].filter((value): value is string => Boolean(value)))),
  };
}

export async function deleteSourceAssetGraph(params: {
  projectId: number;
  sourceAssetId: number;
  userId: number;
  deleteStorageObject?: DeletionStorage;
  abortMultipartUpload?: DeletionMultipartAbort;
}) {
  const requestedGraph = await db.transaction(async (tx) => {
    const graph = await lockSourceDeletionGraph(
      tx,
      params.projectId,
      params.sourceAssetId,
      params.userId
    );
    if (!graph) return null;
    const now = sql<Date>`clock_timestamp()`;
    await tx.update(sourceAssets).set({ deletionRequestedAt: now, updatedAt: now })
      .where(eq(sourceAssets.id, params.sourceAssetId));
    await requestCancellationForJobs(
      tx,
      graph.relatedJobs.map((job) => job.id),
      StaleJobReason.SOURCE_ASSET_DELETED
    );
    return graph;
  });

  if (!requestedGraph) {
    emitDeletionState({ sourceAssetId: params.sourceAssetId, deletionState: 'not_found' });
    return { deleted: false, pending: false, deletedStorageObjectCount: 0 };
  }
  emitDeletionState({ sourceAssetId: params.sourceAssetId, deletionState: 'requested' });

  const readiness = await db.transaction(async (tx) => {
    const graph = await lockSourceDeletionGraph(
      tx,
      params.projectId,
      params.sourceAssetId,
      params.userId
    );
    if (!graph) return { graph: null, ready: false };
    if (!graph.sourceAsset.deletionRequestedAt) return { graph, ready: false };
    await requestCancellationForJobs(
      tx,
      graph.relatedJobs.map((job) => job.id),
      StaleJobReason.SOURCE_ASSET_DELETED
    );
    const activeLease = await hasActiveDeletionLease(
      tx,
      graph.relatedJobs.map((job) => job.id)
    );
    return { graph, ready: !activeLease && !graph.hasCompletingUpload };
  });
  if (!readiness.graph || !readiness.ready) {
    emitDeletionState({ sourceAssetId: params.sourceAssetId, deletionState: 'waiting_for_leases' });
    return { deleted: false, pending: true, deletedStorageObjectCount: 0 };
  }

  const abortMultipart = params.abortMultipartUpload ?? abortStorageMultipartUpload;
  await Promise.all(readiness.graph.multipartUploads.map(abortMultipart));
  const removeStorageObject = params.deleteStorageObject ?? deleteStorageObject;
  await Promise.all(readiness.graph.storageKeys.map(removeStorageObject));

  const finalized = await db.transaction(async (tx) => {
    const graph = await lockSourceDeletionGraph(
      tx,
      params.projectId,
      params.sourceAssetId,
      params.userId
    );
    if (!graph || !graph.sourceAsset.deletionRequestedAt) return false;
    await requestCancellationForJobs(
      tx,
      graph.relatedJobs.map((job) => job.id),
      StaleJobReason.SOURCE_ASSET_DELETED
    );
    if (await hasActiveDeletionLease(tx, graph.relatedJobs.map((job) => job.id))) {
      throw new Error('Source deletion is waiting for active job leases to stop.');
    }
    if (graph.hasCompletingUpload) {
      throw new Error('Source deletion is waiting for upload completion to stop.');
    }
    if (!graph.sourceAsset.deletionRequestedAt) return false;

    if (graph.transcriptId) {
      await tx.delete(transcriptSegments)
        .where(eq(transcriptSegments.transcriptId, graph.transcriptId));
      await tx.delete(transcriptWords)
        .where(eq(transcriptWords.transcriptId, graph.transcriptId));
      await tx.delete(transcripts).where(eq(transcripts.id, graph.transcriptId));
    }
    if (graph.uploadSessionIds.length > 0) {
      await tx.delete(sourceUploadParts)
        .where(inArray(sourceUploadParts.uploadSessionId, graph.uploadSessionIds));
      await tx.delete(sourceUploadSessions)
        .where(inArray(sourceUploadSessions.id, graph.uploadSessionIds));
    }
    await tx.delete(facecamSegments).where(eq(facecamSegments.videoId, params.sourceAssetId));
    await tx.delete(sourceAssetThumbnailVariants)
      .where(eq(sourceAssetThumbnailVariants.sourceAssetId, params.sourceAssetId));
    await tx.delete(sourceAssets).where(eq(sourceAssets.id, params.sourceAssetId));
    return true;
  });

  const result = {
    deleted: finalized,
    pending: false,
    deletedStorageObjectCount: finalized ? readiness.graph.storageKeys.length : 0,
  };
  emitDeletionState({
    sourceAssetId: params.sourceAssetId,
    deletionState: finalized ? 'finalized' : 'finalization_lost',
    deletedObjects: result.deletedStorageObjectCount,
  });
  return result;
}

async function cleanupSourceAsset(
  sourceAsset: Pick<SourceAsset, 'id' | 'storageKey' | 'thumbnailStorageKey'>
) {
  await Promise.all(
    [sourceAsset.storageKey, sourceAsset.thumbnailStorageKey]
      .filter((value): value is string => Boolean(value))
      .map((storageKey) => deleteStorageObject(storageKey))
  );

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

async function hasActiveJobReferencingPayloadField(
  fieldName: 'sourceAssetId' | 'renderedClipId',
  value: number
) {
  const job = await db.query.jobs.findFirst({
    where: and(
      inArray(jobs.status, [JobStatus.PENDING, JobStatus.PROCESSING]),
      sql<boolean>`payload->>${fieldName} = ${String(value)}`
    ),
    columns: {
      id: true,
    },
  });

  return Boolean(job);
}

export async function cleanupExpiredTemporaryMedia(now = new Date()) {
  const pendingProjectDeletions = await db.query.projects.findMany({
    columns: { id: true },
    where: isNotNull(projects.deletionRequestedAt),
  });
  const pendingSourceDeletions = await db.query.sourceAssets.findMany({
    columns: { id: true, projectId: true, userId: true },
    where: isNotNull(sourceAssets.deletionRequestedAt),
  });
  let resumedProjectDeletionCount = 0;
  let resumedSourceDeletionCount = 0;
  const errors: string[] = [];

  for (const project of pendingProjectDeletions) {
    try {
      const result = await deleteProjectGraph({ projectId: project.id });
      if (result.deleted) resumedProjectDeletionCount += 1;
    } catch {
      errors.push('Pending project cleanup failed.');
    }
  }

  for (const sourceAsset of pendingSourceDeletions) {
    try {
      const result = await deleteSourceAssetGraph({
        projectId: sourceAsset.projectId,
        sourceAssetId: sourceAsset.id,
        userId: sourceAsset.userId,
      });
      if (result.deleted) resumedSourceDeletionCount += 1;
    } catch {
      errors.push('Pending source cleanup failed.');
    }
  }

  const expiredProjects = await db.query.projects.findMany({
    columns: {
      id: true,
    },
    where: and(
      eq(projects.isSaved, false),
      lte(projects.expiresAt, now),
      isNull(projects.deletionRequestedAt)
    ),
  });
  const cleanedProjectIds: number[] = [];

  for (const project of expiredProjects) {
    try {
      const result = await deleteProjectGraph({
        projectId: project.id,
      });

      if (result.deleted) {
        cleanedProjectIds.push(project.id);
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('currently being processed')
      ) {
        continue;
      }

      errors.push('Project cleanup failed.');
    }
  }

  const [expiredSourceAssets, expiredRenderedClips] = await Promise.all([
    db.query.sourceAssets.findMany({
      columns: {
        id: true,
        storageKey: true,
        thumbnailStorageKey: true,
      },
      where: and(
        eq(sourceAssets.retentionStatus, MediaRetentionStatus.TEMPORARY),
        lte(sourceAssets.expiresAt, now),
        isNull(sourceAssets.savedAt),
        isNull(sourceAssets.storageDeletedAt),
        isNull(sourceAssets.deletionRequestedAt)
      ),
    }),
    db.query.renderedClips.findMany({
      columns: {
        id: true,
        storageKey: true,
      },
      where: and(
        eq(renderedClips.retentionStatus, MediaRetentionStatus.TEMPORARY),
        inArray(renderedClips.status, [
          RenderedClipStatus.READY,
          RenderedClipStatus.FAILED,
        ]),
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
      if (
        await hasActiveJobReferencingPayloadField('sourceAssetId', sourceAsset.id)
      ) {
        continue;
      }

      await cleanupSourceAsset(sourceAsset);
      deletedSourceAssetCount += 1;
    } catch {
      errors.push('Source asset cleanup failed.');
    }
  }

  for (const renderedClip of expiredRenderedClips) {
    try {
      if (
        await hasActiveJobReferencingPayloadField('renderedClipId', renderedClip.id)
      ) {
        continue;
      }

      await cleanupRenderedClip(renderedClip);
      deletedRenderedClipCount += 1;
    } catch {
      errors.push('Rendered clip cleanup failed.');
    }
  }

  return {
    resumedProjectDeletionCount,
    resumedSourceDeletionCount,
    deletedProjectCount: cleanedProjectIds.length,
    deletedSourceAssetCount,
    deletedRenderedClipCount,
    errorCount: errors.length,
    errors,
  };
}
