import 'server-only';

import { and, eq } from 'drizzle-orm';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { db } from '@/lib/db/drizzle';
import {
  projects,
  MediaRetentionStatus,
  sourceAssets,
  SourceAssetStatus,
  SourceAssetType,
  type User,
} from '@/lib/db/schema';
import {
  MAX_SOURCE_ASSET_FILE_SIZE_BYTES,
  SOURCE_ASSET_ALLOWED_FORMAT_LABEL,
  isSupportedSourceAssetUpload,
} from '@/lib/disburse/source-asset-upload-config';
import {
  buildStorageUrl,
  createPresignedUpload,
  createStorageKey,
} from '@/lib/disburse/s3-storage';
import { triggerInternalJobProcessing } from '@/lib/disburse/internal-job-trigger';
import { enqueueTranscriptionJob } from '@/lib/disburse/job-service';
import { getTemporaryProjectExpiresAt } from '@/lib/disburse/media-retention-service';

const uploadTokenIssuer = 'disburse-source-asset-upload';

type UploadTokenPayload = {
  type: 'source-asset-upload';
  userId: number;
  projectId: number;
  originalFilename: string;
  mimeType: string;
  fileSizeBytes: number;
  storageKey: string;
};

function getUploadTokenKey() {
  if (!process.env.AUTH_SECRET) {
    throw new Error('AUTH_SECRET environment variable is not set');
  }

  return new TextEncoder().encode(process.env.AUTH_SECRET);
}

export const initiateSourceAssetUploadSchema = z.object({
  projectId: z.number().int().positive(),
  filename: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(100),
  fileSizeBytes: z.number().int().positive().max(MAX_SOURCE_ASSET_FILE_SIZE_BYTES),
});

export const completeSourceAssetUploadSchema = z.object({
  uploadToken: z.string().trim().min(1),
  title: z.string().trim().min(1).max(150),
});

export const uploadSourceAssetFileSchema = z.object({
  projectId: z.number().int().positive(),
  title: z.string().trim().min(1).max(150),
});

async function assertProjectOwnership(projectId: number, userId: number) {
  const [project] = await db
    .select({
      id: projects.id,
      expiresAt: projects.expiresAt,
      isSaved: projects.isSaved
    })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);

  if (!project) {
    throw new Error('Project not found.');
  }

  return project;
}

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

async function signUploadToken(payload: UploadTokenPayload) {
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(uploadTokenIssuer)
    .setIssuedAt()
    .setExpirationTime('15 minutes')
    .sign(getUploadTokenKey());
}

async function verifyUploadToken(uploadToken: string) {
  const { payload } = await jwtVerify(uploadToken, getUploadTokenKey(), {
    issuer: uploadTokenIssuer,
    algorithms: ['HS256'],
  });

  if (payload.type !== 'source-asset-upload') {
    throw new Error('Invalid upload token.');
  }

  return payload as UploadTokenPayload;
}

async function uploadFileToStorage(
  upload: ReturnType<typeof createPresignedUpload>,
  file: File
) {
  const response = await fetch(upload.uploadUrl, {
    method: upload.method,
    headers: upload.headers,
    body: Buffer.from(await file.arrayBuffer()),
  });

  if (response.ok) {
    return;
  }

  throw new Error(
    `File upload failed before it could be attached (storage returned ${response.status}).`
  );
}

export async function initiateSourceAssetUpload(
  input: z.infer<typeof initiateSourceAssetUploadSchema>,
  user: User
) {
  await assertProjectOwnership(input.projectId, user.id);

  const metadata = normalizeUploadMetadata(
    input.filename,
    input.mimeType,
    input.fileSizeBytes
  );
  const storageKey = createStorageKey(user.id, input.projectId, metadata.filename);
  const uploadToken = await signUploadToken({
    type: 'source-asset-upload',
    userId: user.id,
    projectId: input.projectId,
    originalFilename: metadata.filename,
    mimeType: metadata.mimeType,
    fileSizeBytes: metadata.fileSizeBytes,
    storageKey,
  });

  return {
    storageKey,
    uploadToken,
    ...createPresignedUpload({
      storageKey,
      mimeType: metadata.mimeType,
    }),
  };
}

export async function completeSourceAssetUpload(
  input: z.infer<typeof completeSourceAssetUploadSchema>,
  user: User
) {
  const payload = await verifyUploadToken(input.uploadToken);

  if (payload.userId !== user.id) {
    throw new Error('You are not authorized to complete this upload.');
  }

  const project = await assertProjectOwnership(payload.projectId, user.id);

  const existing = await db.query.sourceAssets.findFirst({
    where: and(
      eq(sourceAssets.userId, user.id),
      eq(sourceAssets.storageKey, payload.storageKey)
    ),
  });

  if (existing) {
    return {
      sourceAsset: existing,
    };
  }

  const [sourceAsset] = await db
    .insert(sourceAssets)
    .values({
      userId: user.id,
      projectId: payload.projectId,
      title: input.title.trim(),
      assetType: SourceAssetType.UPLOADED_FILE,
      originalFilename: payload.originalFilename,
      mimeType: payload.mimeType,
      storageKey: payload.storageKey,
      storageUrl: buildStorageUrl(payload.storageKey),
      fileSizeBytes: payload.fileSizeBytes,
      status: SourceAssetStatus.UPLOADED,
      retentionStatus: project.isSaved
        ? MediaRetentionStatus.SAVED
        : MediaRetentionStatus.TEMPORARY,
      expiresAt: project.isSaved
        ? null
        : project.expiresAt || getTemporaryProjectExpiresAt(),
      savedAt: project.isSaved ? new Date() : null,
    })
    .onConflictDoNothing({
      target: sourceAssets.storageKey,
    })
    .returning();

  if (sourceAsset) {
    await enqueueTranscriptionJob(sourceAsset.id, user.id);
    triggerInternalJobProcessing();

    return {
      sourceAsset,
    };
  }

  const persistedSourceAsset = await db.query.sourceAssets.findFirst({
    where: and(
      eq(sourceAssets.userId, user.id),
      eq(sourceAssets.storageKey, payload.storageKey)
    ),
  });

  if (!persistedSourceAsset) {
    throw new Error('Upload completed, but the source asset could not be saved.');
  }

  triggerInternalJobProcessing();

  return {
    sourceAsset: persistedSourceAsset,
  };
}

export async function uploadSourceAssetFile(
  input: z.infer<typeof uploadSourceAssetFileSchema> & { file: File },
  user: User
) {
  const upload = await initiateSourceAssetUpload(
    {
      projectId: input.projectId,
      filename: input.file.name,
      mimeType: input.file.type,
      fileSizeBytes: input.file.size,
    },
    user
  );

  await uploadFileToStorage(upload, input.file);

  return await completeSourceAssetUpload(
    {
      uploadToken: upload.uploadToken,
      title: input.title,
    },
    user
  );
}
