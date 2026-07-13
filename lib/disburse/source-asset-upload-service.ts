import 'server-only';

import { and, eq, inArray, lt } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import {
  MediaRetentionStatus,
  projects,
  sourceAssets,
  SourceAssetStatus,
  SourceAssetType,
  sourceUploadParts,
  SourceUploadPartStatus,
  sourceUploadSessions,
  SourceUploadSessionStatus,
  type SourceAsset,
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
import { enqueueSourceAssetThumbnailJob } from '@/lib/disburse/job-service';
import { lockProjectForLifecycleMutation } from '@/lib/disburse/lifecycle-mutation-barrier';
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
  return await enqueueSourceAssetThumbnailJob(sourceAssetId, userId);
}

export async function claimSourceUploadSessionForCompletion(
  uploadSessionId: number,
  userId: number,
  now: Date
) {
  return await db.transaction(async (tx) => {
    const [session] = await tx
      .select({ projectId: sourceUploadSessions.projectId })
      .from(sourceUploadSessions)
      .where(and(
        eq(sourceUploadSessions.id, uploadSessionId),
        eq(sourceUploadSessions.userId, userId)
      ))
      .limit(1);
    if (!session) return null;

    await lockProjectForLifecycleMutation(tx, session.projectId, userId);
    const [claimedSession] = await tx
      .update(sourceUploadSessions)
      .set({
        status: SourceUploadSessionStatus.COMPLETING,
        failureReason: null,
        updatedAt: now,
      })
      .where(and(
        eq(sourceUploadSessions.id, uploadSessionId),
        eq(sourceUploadSessions.userId, userId),
        inArray(sourceUploadSessions.status, [
          SourceUploadSessionStatus.UPLOADING,
          SourceUploadSessionStatus.FAILED,
        ])
      ))
      .returning();
    return claimedSession || null;
  });
}

type InsertUploadSessionInput = Parameters<
  SourceAssetUploadServiceDeps['insertUploadSession']
>[0];

export async function insertSourceUploadSessionWithLifecycleBarrier(
  session: InsertUploadSessionInput
) {
  return await db.transaction(async (tx) => {
    await lockProjectForLifecycleMutation(tx, session.projectId, session.userId);
    const [createdSession] = await tx
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
  });
}

type CompleteUploadSessionInput = Parameters<
  SourceAssetUploadServiceDeps['completeUploadSessionWithSourceAsset']
>[0];

export async function completeSourceUploadSessionAtomically(
  input: CompleteUploadSessionInput,
  beforeCommit?: (sourceAsset: SourceAsset) => Promise<void>
) {
  return await db.transaction(async (tx) => {
    const [project] = await tx
      .select({
        id: projects.id,
        expiresAt: projects.expiresAt,
        isSaved: projects.isSaved,
        deletionRequestedAt: projects.deletionRequestedAt,
      })
      .from(projects)
      .where(and(eq(projects.id, input.projectId), eq(projects.userId, input.userId)))
      .for('update')
      .limit(1);
    if (!project || project.deletionRequestedAt) {
      throw new Error('Upload completion cannot create media under a deleting project.');
    }

    const [session] = await tx
      .select()
      .from(sourceUploadSessions)
      .where(and(
        eq(sourceUploadSessions.id, input.uploadSessionId),
        eq(sourceUploadSessions.userId, input.userId),
        eq(sourceUploadSessions.projectId, input.projectId),
        eq(sourceUploadSessions.storageKey, input.storageKey)
      ))
      .for('update')
      .limit(1);
    if (!session) throw new Error('Upload session not found.');
    if (session.status === SourceUploadSessionStatus.COMPLETED && session.sourceAssetId) {
      return await tx.query.sourceAssets.findFirst({
        where: and(
          eq(sourceAssets.id, session.sourceAssetId),
          eq(sourceAssets.userId, input.userId),
          eq(sourceAssets.projectId, input.projectId)
        ),
      }) || null;
    }
    if (session.status !== SourceUploadSessionStatus.COMPLETING) {
      throw new Error('Upload session is not completing.');
    }

    const [existingSourceAsset] = await tx
      .select()
      .from(sourceAssets)
      .where(and(
        eq(sourceAssets.userId, input.userId),
        eq(sourceAssets.projectId, input.projectId),
        eq(sourceAssets.storageKey, input.storageKey)
      ))
      .for('update')
      .limit(1);
    if (existingSourceAsset?.deletionRequestedAt) {
      throw new Error('Upload completion cannot reuse a deleting source asset.');
    }

    const sourceAsset = existingSourceAsset || (await tx
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
        retentionStatus: project.isSaved
          ? MediaRetentionStatus.SAVED
          : MediaRetentionStatus.TEMPORARY,
        expiresAt: project.isSaved
          ? null
          : project.expiresAt || getTemporaryProjectExpiresAt(),
        savedAt: project.isSaved ? input.now : null,
      })
      .returning())[0];
    if (!sourceAsset) throw new Error('Upload source asset could not be saved.');

    const [completedSession] = await tx
      .update(sourceUploadSessions)
      .set({
        status: SourceUploadSessionStatus.COMPLETED,
        sourceAssetId: sourceAsset.id,
        failureReason: null,
        completedAt: input.now,
        updatedAt: input.now,
      })
      .where(and(
        eq(sourceUploadSessions.id, session.id),
        eq(sourceUploadSessions.status, SourceUploadSessionStatus.COMPLETING)
      ))
      .returning({ id: sourceUploadSessions.id });
    if (!completedSession) throw new Error('Upload session completion lost ownership.');

    await beforeCommit?.(sourceAsset);
    return sourceAsset;
  });
}

const defaultSourceAssetUploadServiceDeps: SourceAssetUploadServiceDeps = {
  now: () => new Date(),
  async assertProjectOwnership(projectId, userId) {
    const [project] = await db
      .select({
        id: projects.id,
        expiresAt: projects.expiresAt,
        isSaved: projects.isSaved,
        deletionRequestedAt: projects.deletionRequestedAt,
      })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
      .limit(1);

    if (!project) {
      throw new Error('Project not found.');
    }
    if (project.deletionRequestedAt) {
      throw new Error('Uploads cannot be changed while this project is being deleted.');
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
    return await insertSourceUploadSessionWithLifecycleBarrier(session);
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
    return await claimSourceUploadSessionForCompletion(
      uploadSessionId,
      userId,
      now
    );
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
  async completeUploadSessionWithSourceAsset(input) {
    return await completeSourceUploadSessionAtomically(input);
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
  enqueueThumbnailJob: defaultEnqueueThumbnailJob,
};

type ProductionUploadIntegrationOverrides = Partial<Pick<
  SourceAssetUploadServiceDeps,
  | 'createStorageKey'
  | 'createMultipartUpload'
  | 'abortMultipartUpload'
  | 'listMultipartUploadParts'
  | 'completeMultipartUpload'
  | 'completeUploadSessionWithSourceAsset'
  | 'createUploadCompletedNotification'
  | 'enqueueThumbnailJob'
>>;

export function createProductionSourceAssetUploadService(
  overrides: ProductionUploadIntegrationOverrides = {}
) {
  return createSourceAssetUploadService({
    ...defaultSourceAssetUploadServiceDeps,
    ...overrides,
  });
}

const defaultSourceAssetUploadService = createProductionSourceAssetUploadService();

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
