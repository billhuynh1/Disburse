import 'server-only';

import { and, eq, inArray, lt } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import {
  jobs,
  JobStatus,
  JobType,
  MediaRetentionStatus,
  projects,
  sourceAssets,
  SourceAssetStatus,
  SourceAssetType,
  sourceUploadParts,
  SourceUploadPartStatus,
  sourceUploadSessions,
  SourceUploadSessionStatus,
} from '@/lib/db/schema';
import {
  abortMultipartUpload,
  buildStorageUrl,
  completeMultipartUpload,
  createMultipartUpload,
  createPresignedUploadPart,
  createStorageKey,
  listMultipartUploadParts,
} from '@/lib/disburse/s3-storage';
import { createUploadCompletedNotification } from '@/lib/disburse/notification-service';
import { getTemporaryProjectExpiresAt } from '@/lib/disburse/media-retention-service';
import { enqueueTranscriptionJob } from '@/lib/disburse/job-service';
import {
  createSourceAssetUploadService,
  initiateSourceAssetUploadSchema,
  sourceAssetUploadSessionSchema,
  sourceAssetUploadPartUrlSchema,
  sourceAssetUploadPartAckSchema,
  completeSourceAssetUploadSchema,
  uploadSourceAssetFileSchema,
  type SourceAssetUploadServiceDeps,
} from './source-asset-upload-service-core.ts';

export {
  initiateSourceAssetUploadSchema,
  sourceAssetUploadSessionSchema,
  sourceAssetUploadPartUrlSchema,
  sourceAssetUploadPartAckSchema,
  completeSourceAssetUploadSchema,
  uploadSourceAssetFileSchema,
  createSourceAssetUploadService,
  uploadSourceAssetFile,
} from './source-asset-upload-service-core.ts';

async function defaultEnqueueThumbnailJob(sourceAssetId: number, userId: number) {
  const idempotencyKey = `source-asset-thumbnail:${sourceAssetId}`;
  const [job] = await db
    .insert(jobs)
    .values({
      type: JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL,
      status: JobStatus.PENDING,
      idempotencyKey,
      payload: { sourceAssetId, userId },
    })
    .onConflictDoNothing({
      target: jobs.idempotencyKey,
    })
    .returning();

  return job || null;
}

const defaultSourceAssetUploadServiceDeps: SourceAssetUploadServiceDeps = {
  now: () => new Date(),
  async assertProjectOwnership(projectId, userId) {
    const [project] = await db
      .select({
        id: projects.id,
        expiresAt: projects.expiresAt,
        isSaved: projects.isSaved,
      })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
      .limit(1);

    if (!project) {
      throw new Error('Project not found.');
    }

    return project;
  },
  async getAuthorizedSession(uploadSessionId, userId) {
    const session = await db.query.sourceUploadSessions.findFirst({
      where: and(
        eq(sourceUploadSessions.id, uploadSessionId),
        eq(sourceUploadSessions.userId, userId)
      ),
    });

    if (!session) {
      throw new Error('Upload session not found.');
    }

    return session;
  },
  async findExistingSessionWithParts(userId, projectId, idempotencyKey) {
    return (
      (await db.query.sourceUploadSessions.findFirst({
        where: and(
          eq(sourceUploadSessions.userId, userId),
          eq(sourceUploadSessions.projectId, projectId),
          eq(sourceUploadSessions.idempotencyKey, idempotencyKey)
        ),
        with: { parts: true },
      })) || null
    );
  },
  async insertUploadSession(session) {
    const [createdSession] = await db
      .insert(sourceUploadSessions)
      .values(session)
      .onConflictDoNothing({
        target: [
          sourceUploadSessions.userId,
          sourceUploadSessions.projectId,
          sourceUploadSessions.idempotencyKey,
        ],
      })
      .returning();

    return createdSession || null;
  },
  async findUploadParts(uploadSessionId) {
    return await db.query.sourceUploadParts.findMany({
      where: eq(sourceUploadParts.uploadSessionId, uploadSessionId),
      orderBy: (parts, { asc }) => [asc(parts.partNumber)],
    });
  },
  async findUploadPart(uploadSessionId, partNumber) {
    return (
      (await db.query.sourceUploadParts.findFirst({
        where: and(
          eq(sourceUploadParts.uploadSessionId, uploadSessionId),
          eq(sourceUploadParts.partNumber, partNumber)
        ),
      })) || null
    );
  },
  async insertUploadPart(part) {
    const [createdPart] = await db
      .insert(sourceUploadParts)
      .values(part)
      .onConflictDoNothing({
        target: [sourceUploadParts.uploadSessionId, sourceUploadParts.partNumber],
      })
      .returning();

    return createdPart || null;
  },
  async findSourceAssetByIdForUser(sourceAssetId, userId) {
    return (
      (await db.query.sourceAssets.findFirst({
        where: and(eq(sourceAssets.id, sourceAssetId), eq(sourceAssets.userId, userId)),
      })) || null
    );
  },
  async claimUploadSessionForCompletion(uploadSessionId, userId, now) {
    const [claimedSession] = await db
      .update(sourceUploadSessions)
      .set({
        status: SourceUploadSessionStatus.COMPLETING,
        failureReason: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(sourceUploadSessions.id, uploadSessionId),
          eq(sourceUploadSessions.userId, userId),
          inArray(sourceUploadSessions.status, [
            SourceUploadSessionStatus.UPLOADING,
            SourceUploadSessionStatus.FAILED,
          ])
        )
      )
      .returning();

    return claimedSession || null;
  },
  async markUploadSessionCompleted(uploadSessionId, sourceAssetId, now) {
    await db
      .update(sourceUploadSessions)
      .set({
        status: SourceUploadSessionStatus.COMPLETED,
        sourceAssetId,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(sourceUploadSessions.id, uploadSessionId));
  },
  async markUploadSessionFailed(uploadSessionId, failureReason, now) {
    await db
      .update(sourceUploadSessions)
      .set({
        status: SourceUploadSessionStatus.FAILED,
        failureReason,
        updatedAt: now,
      })
      .where(eq(sourceUploadSessions.id, uploadSessionId));
  },
  async markUploadSessionAborted(uploadSessionId, userId, now) {
    const [updatedSession] = await db
      .update(sourceUploadSessions)
      .set({
        status: SourceUploadSessionStatus.ABORTED,
        abortedAt: now,
        updatedAt: now,
      })
      .where(
        and(eq(sourceUploadSessions.id, uploadSessionId), eq(sourceUploadSessions.userId, userId))
      )
      .returning();

    return updatedSession || null;
  },
  async findExistingSourceAssetByStorageKey(userId, storageKey) {
    return (
      (await db.query.sourceAssets.findFirst({
        where: and(eq(sourceAssets.userId, userId), eq(sourceAssets.storageKey, storageKey)),
      })) || null
    );
  },
  async createSourceAssetInTransaction(input) {
    return await db.transaction(async (tx) => {
      const existingSourceAsset = await tx.query.sourceAssets.findFirst({
        where: and(
          eq(sourceAssets.userId, input.userId),
          eq(sourceAssets.storageKey, input.storageKey)
        ),
      });

      if (existingSourceAsset) {
        return existingSourceAsset;
      }

      const [createdSourceAsset] = await tx
        .insert(sourceAssets)
        .values({
          userId: input.userId,
          projectId: input.projectId,
          title: input.title.trim(),
          assetType: SourceAssetType.UPLOADED_FILE,
          originalFilename: input.originalFilename,
          mimeType: input.mimeType,
          storageKey: input.storageKey,
          storageUrl: buildStorageUrl(input.storageKey),
          fileSizeBytes: input.fileSizeBytes,
          status: SourceAssetStatus.UPLOADED,
          retentionStatus: input.project.isSaved
            ? MediaRetentionStatus.SAVED
            : MediaRetentionStatus.TEMPORARY,
          expiresAt: input.project.isSaved
            ? null
            : input.project.expiresAt || getTemporaryProjectExpiresAt(),
          savedAt: input.project.isSaved ? input.now : null,
        })
        .onConflictDoNothing({
          target: sourceAssets.storageKey,
        })
        .returning();

      return (
        createdSourceAsset ||
        (await tx.query.sourceAssets.findFirst({
          where: and(
            eq(sourceAssets.userId, input.userId),
            eq(sourceAssets.storageKey, input.storageKey)
          ),
        }))
      );
    });
  },
  async findStaleSessions(staleBefore) {
    return await db.query.sourceUploadSessions.findMany({
      where: and(
        inArray(sourceUploadSessions.status, [
          SourceUploadSessionStatus.UPLOADING,
          SourceUploadSessionStatus.COMPLETING,
          SourceUploadSessionStatus.FAILED,
        ]),
        lt(sourceUploadSessions.updatedAt, staleBefore)
      ),
    });
  },
  async markStaleSessionAborted(uploadSessionId, now) {
    await db
      .update(sourceUploadSessions)
      .set({
        status: SourceUploadSessionStatus.ABORTED,
        abortedAt: now,
        updatedAt: now,
      })
      .where(eq(sourceUploadSessions.id, uploadSessionId));
  },
  createStorageKey,
  createMultipartUpload,
  createPresignedUploadPart,
  listMultipartUploadParts,
  completeMultipartUpload,
  abortMultipartUpload,
  createUploadCompletedNotification,
  enqueueTranscriptionJob,
  enqueueThumbnailJob: defaultEnqueueThumbnailJob,
};

const defaultSourceAssetUploadService = createSourceAssetUploadService(
  defaultSourceAssetUploadServiceDeps
);

export const initiateSourceAssetUpload =
  defaultSourceAssetUploadService.initiateSourceAssetUpload;
export const getSourceAssetUploadStatus =
  defaultSourceAssetUploadService.getSourceAssetUploadStatus;
export const createSourceAssetUploadPartUrl =
  defaultSourceAssetUploadService.createSourceAssetUploadPartUrl;
export const acknowledgeSourceAssetUploadPart =
  defaultSourceAssetUploadService.acknowledgeSourceAssetUploadPart;
export const completeSourceAssetUpload =
  defaultSourceAssetUploadService.completeSourceAssetUpload;
export const abortSourceAssetUpload =
  defaultSourceAssetUploadService.abortSourceAssetUpload;
export const cleanupStaleSourceUploadSessions =
  defaultSourceAssetUploadService.cleanupStaleSourceUploadSessions;
