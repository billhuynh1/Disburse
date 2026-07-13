import { z } from 'zod';
import {
  MAX_SOURCE_ASSET_FILE_SIZE_BYTES,
  MAX_MULTIPART_PARTS,
  MAX_MULTIPART_PART_SIZE_BYTES,
  MIN_MULTIPART_PART_SIZE_BYTES,
  SOURCE_ASSET_ALLOWED_FORMAT_LABEL,
  computeMultipartPlan,
  isSupportedSourceAssetUpload,
} from './source-asset-upload-config.ts';
import {
  MediaRetentionStatus,
  SourceAssetStatus,
  SourceAssetType,
  SourceUploadPartStatus,
  SourceUploadSessionStatus,
  type SourceAsset,
  type SourceUploadPart,
  type SourceUploadSession,
  type User,
} from '../db/schema.ts';
import type { S3MultipartPart } from './s3-storage.ts';

const SESSION_EXPIRES_MS = 24 * 60 * 60 * 1000;
const STALE_SESSION_MS = 24 * 60 * 60 * 1000;

export const initiateSourceAssetUploadSchema = z.object({
  projectId: z.number().int().positive(),
  filename: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(100),
  fileSizeBytes: z.number().int().positive().max(MAX_SOURCE_ASSET_FILE_SIZE_BYTES),
  idempotencyKey: z.string().trim().min(8).max(200),
});

export const sourceAssetUploadSessionSchema = z.object({
  uploadSessionId: z.number().int().positive(),
});

export const sourceAssetUploadPartUrlSchema = sourceAssetUploadSessionSchema.extend({
  partNumber: z.number().int().positive().max(MAX_MULTIPART_PARTS),
});

export const sourceAssetUploadPartAckSchema = sourceAssetUploadPartUrlSchema.extend({
  etag: z.string().trim().min(1).max(500),
  checksumSha256: z.string().trim().min(1).max(200).optional(),
});

export const completeSourceAssetUploadSchema = sourceAssetUploadSessionSchema.extend({
  title: z.string().trim().min(1).max(150),
});

export const uploadSourceAssetFileSchema = z.object({
  projectId: z.number().int().positive(),
  title: z.string().trim().min(1).max(150),
});

export type OwnedProject = {
  id: number;
  expiresAt: Date | null;
  isSaved: boolean;
};

type SessionPartSummary = Pick<SourceUploadPart, 'partNumber' | 'etag'>;
type SessionWithParts = SourceUploadSession & { parts: SessionPartSummary[] };
type UploadedPartResponse = {
  partNumber: number;
  etag: string;
};
type UploadSessionResponse = {
  session: ReturnType<typeof serializeSession>;
  uploadedParts: UploadedPartResponse[];
};
type UploadPartUrlResponse =
  | {
      alreadyUploaded: true;
      partNumber: number;
      etag: string;
    }
  | {
      alreadyUploaded: false;
      partNumber: number;
      method: 'PUT';
      uploadUrl: string;
      headers: Record<string, string>;
    };
type CompletedUploadResponse = {
  sourceAsset: SourceAsset;
};
type AbortedUploadResponse = {
  session: ReturnType<typeof serializeSession>;
};

type CreateSourceAssetInput = {
  userId: number;
  projectId: number;
  title: string;
  originalFilename: string;
  mimeType: string;
  storageKey: string;
  fileSizeBytes: number;
  project: OwnedProject;
  now: Date;
};

export type SourceAssetUploadServiceDeps = {
  now: () => Date;
  assertProjectOwnership: (projectId: number, userId: number) => Promise<OwnedProject>;
  getAuthorizedSession: (
    uploadSessionId: number,
    userId: number
  ) => Promise<SourceUploadSession>;
  findExistingSessionWithParts: (
    userId: number,
    projectId: number,
    idempotencyKey: string
  ) => Promise<SessionWithParts | null>;
  insertUploadSession: (session: {
    userId: number;
    projectId: number;
    idempotencyKey: string;
    originalFilename: string;
    mimeType: string;
    fileSizeBytes: number;
    storageKey: string;
    uploadId: string;
    partSizeBytes: number;
    totalParts: number;
    status: SourceUploadSessionStatus;
    expiresAt: Date;
  }) => Promise<SourceUploadSession | null>;
  findUploadParts: (uploadSessionId: number) => Promise<SourceUploadPart[]>;
  findUploadPart: (
    uploadSessionId: number,
    partNumber: number
  ) => Promise<SourceUploadPart | null>;
  insertUploadPart: (part: {
    uploadSessionId: number;
    partNumber: number;
    byteStart: number;
    byteEnd: number;
    sizeBytes: number;
    etag: string;
    checksumSha256?: string;
    status: SourceUploadPartStatus;
    updatedAt: Date;
  }) => Promise<SourceUploadPart | null>;
  findSourceAssetByIdForUser: (
    sourceAssetId: number,
    userId: number
  ) => Promise<SourceAsset | null>;
  claimUploadSessionForCompletion: (
    uploadSessionId: number,
    userId: number,
    now: Date
  ) => Promise<SourceUploadSession | null>;
  markUploadSessionCompleted: (
    uploadSessionId: number,
    sourceAssetId: number,
    now: Date
  ) => Promise<void>;
  markUploadSessionFailed: (
    uploadSessionId: number,
    failureReason: string,
    now: Date
  ) => Promise<void>;
  markUploadSessionAborted: (
    uploadSessionId: number,
    userId: number,
    now: Date
  ) => Promise<SourceUploadSession | null>;
  findExistingSourceAssetByStorageKey: (
    userId: number,
    storageKey: string
  ) => Promise<SourceAsset | null>;
  createSourceAssetInTransaction: (
    input: CreateSourceAssetInput
  ) => Promise<SourceAsset | null>;
  findStaleSessions: (staleBefore: Date) => Promise<SourceUploadSession[]>;
  markStaleSessionAborted: (uploadSessionId: number, now: Date) => Promise<void>;
  createStorageKey: (userId: number, projectId: number, filename: string) => string;
  createMultipartUpload: (params: {
    storageKey: string;
    mimeType: string;
  }) => Promise<{ uploadId: string }>;
  createPresignedUploadPart: (params: {
    storageKey: string;
    uploadId: string;
    partNumber: number;
  }) => {
    method: 'PUT';
    uploadUrl: string;
    headers: Record<string, string>;
  };
  listMultipartUploadParts: (params: {
    storageKey: string;
    uploadId: string;
  }) => Promise<S3MultipartPart[]>;
  completeMultipartUpload: (params: {
    storageKey: string;
    uploadId: string;
    parts: S3MultipartPart[];
  }) => Promise<void>;
  abortMultipartUpload: (params: {
    storageKey: string;
    uploadId: string;
  }) => Promise<void>;
  createUploadCompletedNotification: (sourceAssetId: number) => Promise<void>;
  enqueueThumbnailJob: (
    sourceAssetId: number,
    userId: number
  ) => Promise<unknown>;
};

function normalizeUploadMetadata(
  filename: string,
  mimeType: string,
  fileSizeBytes: number
) {
  const normalizedFilename = filename.trim();
  const normalizedMimeType = mimeType.trim().toLowerCase();

  if (!isSupportedSourceAssetUpload(normalizedFilename, normalizedMimeType)) {
    throw new Error(
      `Unsupported file type. Upload ${SOURCE_ASSET_ALLOWED_FORMAT_LABEL}.`
    );
  }

  if (fileSizeBytes > MAX_SOURCE_ASSET_FILE_SIZE_BYTES) {
    throw new Error('File exceeds the 500 MB upload limit.');
  }

  return {
    filename: normalizedFilename,
    mimeType: normalizedMimeType,
    fileSizeBytes,
  };
}

function getExpectedPartBounds(session: SourceUploadSession, partNumber: number) {
  if (partNumber < 1 || partNumber > session.totalParts) {
    throw new Error('Invalid upload part number.');
  }

  const byteStart = (partNumber - 1) * session.partSizeBytes;
  const byteEnd = Math.min(byteStart + session.partSizeBytes, session.fileSizeBytes);
  const sizeBytes = byteEnd - byteStart;
  const isFinalPart = partNumber === session.totalParts;

  if (
    (!isFinalPart && sizeBytes < MIN_MULTIPART_PART_SIZE_BYTES) ||
    sizeBytes > MAX_MULTIPART_PART_SIZE_BYTES
  ) {
    throw new Error('Invalid upload part size.');
  }

  return {
    byteStart,
    byteEnd: byteEnd - 1,
    sizeBytes,
  };
}

function serializeSession(session: SourceUploadSession) {
  return {
    id: session.id,
    projectId: session.projectId,
    storageKey: session.storageKey,
    partSizeBytes: session.partSizeBytes,
    totalParts: session.totalParts,
    fileSizeBytes: session.fileSizeBytes,
    status: session.status,
    sourceAssetId: session.sourceAssetId,
    failureReason: session.failureReason,
  };
}

export function createSourceAssetUploadService(
  deps: SourceAssetUploadServiceDeps
) {
  const service = {
    async initiateSourceAssetUpload(
      input: z.infer<typeof initiateSourceAssetUploadSchema>,
      user: User
    ): Promise<UploadSessionResponse> {
      await deps.assertProjectOwnership(input.projectId, user.id);

      const metadata = normalizeUploadMetadata(
        input.filename,
        input.mimeType,
        input.fileSizeBytes
      );
      const existing = await deps.findExistingSessionWithParts(
        user.id,
        input.projectId,
        input.idempotencyKey
      );

      if (existing) {
        return {
          session: serializeSession(existing),
          uploadedParts: existing.parts.map((part) => ({
            partNumber: part.partNumber,
            etag: part.etag,
          })),
        };
      }

      const { partSizeBytes, totalParts } = computeMultipartPlan(
        metadata.fileSizeBytes
      );
      const storageKey = deps.createStorageKey(
        user.id,
        input.projectId,
        metadata.filename
      );
      // A process crash after provider creation and before persistence or compensation
      // can still leave an unregistered multipart upload.
      const { uploadId } = await deps.createMultipartUpload({
        storageKey,
        mimeType: metadata.mimeType,
      });
      const expiresAt = new Date(deps.now().getTime() + SESSION_EXPIRES_MS);
      let session: SourceUploadSession | null;
      try {
        session = await deps.insertUploadSession({
          userId: user.id,
          projectId: input.projectId,
          idempotencyKey: input.idempotencyKey,
          originalFilename: metadata.filename,
          mimeType: metadata.mimeType,
          fileSizeBytes: metadata.fileSizeBytes,
          storageKey,
          uploadId,
          partSizeBytes,
          totalParts,
          status: SourceUploadSessionStatus.UPLOADING,
          expiresAt,
        });
      } catch (error) {
        try {
          await deps.abortMultipartUpload({ storageKey, uploadId });
        } catch (abortError) {
          console.error('source_upload.initiation_compensation_failed', {
            storageKey,
            uploadId,
            error: abortError,
          });
        }
        throw error;
      }

      if (session) {
        return { session: serializeSession(session), uploadedParts: [] };
      }

      await deps.abortMultipartUpload({ storageKey, uploadId });
      return await service.initiateSourceAssetUpload(input, user);
    },

    async getSourceAssetUploadStatus(
      input: z.infer<typeof sourceAssetUploadSessionSchema>,
      user: User
    ): Promise<UploadSessionResponse> {
      const session = await deps.getAuthorizedSession(input.uploadSessionId, user.id);
      const parts = await deps.findUploadParts(session.id);

      return {
        session: serializeSession(session),
        uploadedParts: parts.map((part) => ({
          partNumber: part.partNumber,
          etag: part.etag,
        })),
      };
    },

    async createSourceAssetUploadPartUrl(
      input: z.infer<typeof sourceAssetUploadPartUrlSchema>,
      user: User
    ): Promise<UploadPartUrlResponse> {
      const session = await deps.getAuthorizedSession(input.uploadSessionId, user.id);

      if (session.status !== SourceUploadSessionStatus.UPLOADING) {
        throw new Error('Upload session is not accepting parts.');
      }

      getExpectedPartBounds(session, input.partNumber);

      const existingPart = await deps.findUploadPart(session.id, input.partNumber);

      if (existingPart) {
        return {
          alreadyUploaded: true,
          partNumber: existingPart.partNumber,
          etag: existingPart.etag,
        };
      }

      return {
        alreadyUploaded: false,
        partNumber: input.partNumber,
        ...deps.createPresignedUploadPart({
          storageKey: session.storageKey,
          uploadId: session.uploadId,
          partNumber: input.partNumber,
        }),
      };
    },

    async acknowledgeSourceAssetUploadPart(
      input: z.infer<typeof sourceAssetUploadPartAckSchema>,
      user: User
    ): Promise<UploadedPartResponse> {
      const session = await deps.getAuthorizedSession(input.uploadSessionId, user.id);

      if (session.status !== SourceUploadSessionStatus.UPLOADING) {
        throw new Error('Upload session is not accepting parts.');
      }

      const bounds = getExpectedPartBounds(session, input.partNumber);
      const existingPart = await deps.findUploadPart(session.id, input.partNumber);

      if (existingPart) {
        if (existingPart.etag !== input.etag) {
          throw new Error('Part acknowledgement conflicts with an existing part.');
        }

        return {
          partNumber: existingPart.partNumber,
          etag: existingPart.etag,
        };
      }

      const part = await deps.insertUploadPart({
        uploadSessionId: session.id,
        partNumber: input.partNumber,
        byteStart: bounds.byteStart,
        byteEnd: bounds.byteEnd,
        sizeBytes: bounds.sizeBytes,
        etag: input.etag,
        checksumSha256: input.checksumSha256,
        status: SourceUploadPartStatus.UPLOADED,
        updatedAt: deps.now(),
      });

      if (!part) {
        return await service.acknowledgeSourceAssetUploadPart(input, user);
      }

      return {
        partNumber: part.partNumber,
        etag: part.etag,
      };
    },

    async completeSourceAssetUpload(
      input: z.infer<typeof completeSourceAssetUploadSchema>,
      user: User
    ): Promise<CompletedUploadResponse> {
      const session = await deps.getAuthorizedSession(input.uploadSessionId, user.id);

      if (
        session.status === SourceUploadSessionStatus.COMPLETED &&
        session.sourceAssetId
      ) {
        const sourceAsset = await deps.findSourceAssetByIdForUser(
          session.sourceAssetId,
          user.id
        );

        if (sourceAsset) {
          return { sourceAsset };
        }
      }

      if (
        session.status !== SourceUploadSessionStatus.UPLOADING &&
        session.status !== SourceUploadSessionStatus.FAILED
      ) {
        throw new Error('Upload session cannot be completed.');
      }

      const claimedSession = await deps.claimUploadSessionForCompletion(
        session.id,
        user.id,
        deps.now()
      );

      if (!claimedSession) {
        return await service.completeSourceAssetUpload(input, user);
      }

      try {
        const [dbParts, s3Parts, project] = await Promise.all([
          deps.findUploadParts(claimedSession.id),
          deps.listMultipartUploadParts({
            storageKey: claimedSession.storageKey,
            uploadId: claimedSession.uploadId,
          }),
          deps.assertProjectOwnership(claimedSession.projectId, user.id),
        ]);

        if (dbParts.length !== claimedSession.totalParts) {
          throw new Error('Upload is missing one or more parts.');
        }

        const s3PartByNumber = new Map(
          s3Parts.map((part) => [part.partNumber, part])
        );

        for (const dbPart of dbParts) {
          const s3Part = s3PartByNumber.get(dbPart.partNumber);

          if (!s3Part || s3Part.etag !== dbPart.etag) {
            throw new Error('Uploaded parts do not match storage state.');
          }
        }

        await deps.completeMultipartUpload({
          storageKey: claimedSession.storageKey,
          uploadId: claimedSession.uploadId,
          parts: dbParts.map((part) => ({
            partNumber: part.partNumber,
            etag: part.etag,
          })),
        });

        const now = deps.now();
        const sourceAsset =
          (await deps.findExistingSourceAssetByStorageKey(
            user.id,
            claimedSession.storageKey
          )) ||
          (await deps.createSourceAssetInTransaction({
            userId: user.id,
            projectId: claimedSession.projectId,
            title: input.title.trim(),
            originalFilename: claimedSession.originalFilename,
            mimeType: claimedSession.mimeType,
            storageKey: claimedSession.storageKey,
            fileSizeBytes: claimedSession.fileSizeBytes,
            project,
            now,
          }));

        if (!sourceAsset) {
          throw new Error('Upload completed, but the source asset could not be saved.');
        }

        await deps.markUploadSessionCompleted(claimedSession.id, sourceAsset.id, now);
        await deps.createUploadCompletedNotification(sourceAsset.id);
        await deps.enqueueThumbnailJob(sourceAsset.id, user.id);

        return { sourceAsset };
      } catch (error) {
        await deps.markUploadSessionFailed(
          claimedSession.id,
          error instanceof Error ? error.message : 'Upload failed.',
          deps.now()
        );
        throw error;
      }
    },

    async abortSourceAssetUpload(
      input: z.infer<typeof sourceAssetUploadSessionSchema>,
      user: User
    ): Promise<AbortedUploadResponse> {
      const session = await deps.getAuthorizedSession(input.uploadSessionId, user.id);

      if (
        session.status === SourceUploadSessionStatus.COMPLETED ||
        session.status === SourceUploadSessionStatus.ABORTED
      ) {
        return { session: serializeSession(session) };
      }

      await deps.abortMultipartUpload({
        storageKey: session.storageKey,
        uploadId: session.uploadId,
      });

      const updatedSession = await deps.markUploadSessionAborted(
        session.id,
        user.id,
        deps.now()
      );

      return { session: serializeSession(updatedSession || session) };
    },

    async cleanupStaleSourceUploadSessions(now: Date = deps.now()) {
      const staleBefore = new Date(now.getTime() - STALE_SESSION_MS);
      const staleSessions = await deps.findStaleSessions(staleBefore);

      for (const session of staleSessions) {
        await deps
          .abortMultipartUpload({
            storageKey: session.storageKey,
            uploadId: session.uploadId,
          })
          .catch(() => undefined);
        await deps.markStaleSessionAborted(session.id, now);
      }

      return staleSessions.length;
    },
  };

  return service;
}

export async function uploadSourceAssetFile() {
  throw new Error('Full source video server upload fallback is disabled.');
}
