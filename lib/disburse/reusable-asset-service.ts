import 'server-only';

import { and, desc, eq } from 'drizzle-orm';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { db } from '@/lib/db/drizzle';
import {
  MediaRetentionStatus,
  projects,
  reusableAssets,
  ReusableAssetKind,
  sourceAssets,
  SourceAssetStatus,
  SourceAssetType,
  type User,
} from '@/lib/db/schema';
import {
  buildStorageUrl,
  createStorageKey,
  createPresignedUpload,
  createReusableAssetStorageKey,
  createPresignedDownload,
  deleteStorageObject,
  uploadStorageObject,
} from '@/lib/disburse/s3-storage';
import { createUploadCompletedNotification } from '@/lib/disburse/notification-service';
import { enqueueTranscriptionJob } from '@/lib/disburse/job-service';
import { triggerInternalJobProcessing } from '@/lib/disburse/internal-job-trigger';
import { getTemporaryProjectExpiresAt } from '@/lib/disburse/media-retention-service';

const uploadTokenIssuer = 'disburse-reusable-asset-upload';
const MAX_REUSABLE_ASSET_FILE_SIZE_BYTES = 500 * 1024 * 1024;

const reusableAssetMimeTypeMap: Record<ReusableAssetKind, string[]> = {
  [ReusableAssetKind.FONT]: [
    'font/otf',
    'font/ttf',
    'font/woff',
    'font/woff2',
    'application/font-woff',
    'application/font-woff2',
    'application/x-font-ttf',
    'application/x-font-opentype',
    'application/octet-stream',
  ],
  [ReusableAssetKind.IMAGE]: [
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'image/svg+xml',
  ],
  [ReusableAssetKind.VIDEO]: [
    'video/mp4',
    'video/quicktime',
    'video/webm',
    'video/x-matroska',
  ],
  [ReusableAssetKind.AUDIO]: [
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/x-wav',
    'audio/mp4',
    'audio/x-m4a',
    'audio/webm',
  ],
};

type UploadTokenPayload = {
  type: 'reusable-asset-upload';
  userId: number;
  kind: ReusableAssetKind;
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

function normalizeTitle(filename: string) {
  const withoutExtension = filename.replace(/\.[^.]+$/, '');
  const normalized = withoutExtension.trim().replace(/\s+/g, ' ');
  return normalized.slice(0, 150) || 'Reusable asset';
}

function isReusableAssetMimeTypeAllowed(
  kind: ReusableAssetKind,
  mimeType: string,
  filename: string
) {
  const normalizedMimeType = mimeType.trim().toLowerCase();

  if (reusableAssetMimeTypeMap[kind].includes(normalizedMimeType)) {
    return true;
  }

  const lowerFilename = filename.trim().toLowerCase();

  if (kind === ReusableAssetKind.FONT) {
    return ['.otf', '.ttf', '.woff', '.woff2'].some((extension) =>
      lowerFilename.endsWith(extension)
    );
  }

  return false;
}

function normalizeUploadMetadata(
  kind: ReusableAssetKind,
  filename: string,
  mimeType: string,
  fileSizeBytes: number
) {
  const normalizedFilename = filename.trim();
  const normalizedMimeType = mimeType.trim().toLowerCase();

  if (!normalizedFilename) {
    throw new Error('Filename is required.');
  }

  if (
    fileSizeBytes <= 0 ||
    fileSizeBytes > MAX_REUSABLE_ASSET_FILE_SIZE_BYTES
  ) {
    throw new Error('File exceeds the 500 MB upload limit.');
  }

  if (
    !isReusableAssetMimeTypeAllowed(
      kind,
      normalizedMimeType,
      normalizedFilename
    )
  ) {
    throw new Error('Unsupported reusable asset file type.');
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

  if (payload.type !== 'reusable-asset-upload') {
    throw new Error('Invalid reusable asset upload token.');
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

  if (!response.ok) {
    throw new Error(
      `File upload failed before it could be attached (storage returned ${response.status}).`
    );
  }
}

export const initiateReusableAssetUploadSchema = z.object({
  kind: z.nativeEnum(ReusableAssetKind),
  filename: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(100),
  fileSizeBytes: z.number().int().positive().max(MAX_REUSABLE_ASSET_FILE_SIZE_BYTES),
});

export const completeReusableAssetUploadSchema = z.object({
  uploadToken: z.string().trim().min(1),
});

export const uploadReusableAssetFileSchema = z.object({
  kind: z.nativeEnum(ReusableAssetKind),
});

export const useReusableAssetInProjectSchema = z.object({
  projectId: z.number().int().positive(),
});

export async function listReusableAssetsForUser(userId: number) {
  return await db.query.reusableAssets.findMany({
    where: eq(reusableAssets.userId, userId),
    orderBy: [desc(reusableAssets.updatedAt), desc(reusableAssets.createdAt)],
  });
}

export async function initiateReusableAssetUpload(
  input: z.infer<typeof initiateReusableAssetUploadSchema>,
  user: User
) {
  const metadata = normalizeUploadMetadata(
    input.kind,
    input.filename,
    input.mimeType,
    input.fileSizeBytes
  );
  const storageKey = createReusableAssetStorageKey(
    user.id,
    input.kind,
    metadata.filename
  );
  const uploadToken = await signUploadToken({
    type: 'reusable-asset-upload',
    userId: user.id,
    kind: input.kind,
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

export async function completeReusableAssetUpload(
  input: z.infer<typeof completeReusableAssetUploadSchema>,
  user: User
) {
  const payload = await verifyUploadToken(input.uploadToken);

  if (payload.userId !== user.id) {
    throw new Error('You are not authorized to complete this upload.');
  }

  const existingAsset = await db.query.reusableAssets.findFirst({
    where: and(
      eq(reusableAssets.userId, user.id),
      eq(reusableAssets.storageKey, payload.storageKey)
    ),
  });

  if (existingAsset) {
    return {
      asset: existingAsset,
    };
  }

  const [asset] = await db
    .insert(reusableAssets)
    .values({
      userId: user.id,
      kind: payload.kind,
      title: normalizeTitle(payload.originalFilename),
      originalFilename: payload.originalFilename,
      mimeType: payload.mimeType,
      storageKey: payload.storageKey,
      storageUrl: buildStorageUrl(payload.storageKey),
      fileSizeBytes: payload.fileSizeBytes,
    })
    .onConflictDoNothing({
      target: reusableAssets.storageKey,
    })
    .returning();

  if (asset) {
    return {
      asset,
    };
  }

  const persistedAsset = await db.query.reusableAssets.findFirst({
    where: and(
      eq(reusableAssets.userId, user.id),
      eq(reusableAssets.storageKey, payload.storageKey)
    ),
  });

  if (!persistedAsset) {
    throw new Error(
      'Upload completed, but the reusable asset could not be saved.'
    );
  }

  return {
    asset: persistedAsset,
  };
}

export async function uploadReusableAssetFile(
  input: z.infer<typeof uploadReusableAssetFileSchema> & { file: File },
  user: User
) {
  const metadata = normalizeUploadMetadata(
    input.kind,
    input.file.name,
    input.file.type,
    input.file.size
  );
  const storageKey = createReusableAssetStorageKey(
    user.id,
    input.kind,
    metadata.filename
  );

  await uploadStorageObject({
    storageKey,
    mimeType: metadata.mimeType,
    body: Buffer.from(await input.file.arrayBuffer()),
  });

  const [asset] = await db
    .insert(reusableAssets)
    .values({
      userId: user.id,
      kind: input.kind,
      title: normalizeTitle(metadata.filename),
      originalFilename: metadata.filename,
      mimeType: metadata.mimeType,
      storageKey,
      storageUrl: buildStorageUrl(storageKey),
      fileSizeBytes: metadata.fileSizeBytes,
    })
    .returning();

  return {
    asset,
  };
}

export async function getReusableAssetForUser(assetId: number, userId: number) {
  return await db.query.reusableAssets.findFirst({
    where: and(eq(reusableAssets.id, assetId), eq(reusableAssets.userId, userId)),
  });
}

async function downloadReusableAssetFile(storageKey: string) {
  const download = createPresignedDownload({ storageKey });
  const response = await fetch(download.downloadUrl, {
    method: download.method,
  });

  if (!response.ok) {
    throw new Error(`Reusable asset download failed with status ${response.status}.`);
  }

  return Buffer.from(await response.arrayBuffer());
}

export async function copyReusableMediaAssetToProject(
  assetId: number,
  input: z.infer<typeof useReusableAssetInProjectSchema>,
  user: User
) {
  const reusableAsset = await getReusableAssetForUser(assetId, user.id);

  if (!reusableAsset) {
    throw new Error('Reusable asset not found.');
  }

  if (
    reusableAsset.kind !== ReusableAssetKind.VIDEO &&
    reusableAsset.kind !== ReusableAssetKind.AUDIO
  ) {
    throw new Error('Only reusable video and audio files can be used as project sources.');
  }

  const [project] = await db
    .select({
      id: projects.id,
      expiresAt: projects.expiresAt,
      isSaved: projects.isSaved,
    })
    .from(projects)
    .where(and(eq(projects.id, input.projectId), eq(projects.userId, user.id)))
    .limit(1);

  if (!project) {
    throw new Error('Project not found.');
  }

  const storageKey = createStorageKey(
    user.id,
    project.id,
    reusableAsset.originalFilename
  );
  const fileBuffer = await downloadReusableAssetFile(reusableAsset.storageKey);

  await uploadStorageObject({
    storageKey,
    mimeType: reusableAsset.mimeType,
    body: fileBuffer,
  });

  const [sourceAsset] = await db
    .insert(sourceAssets)
    .values({
      userId: user.id,
      projectId: project.id,
      title: reusableAsset.title,
      assetType: SourceAssetType.UPLOADED_FILE,
      originalFilename: reusableAsset.originalFilename,
      mimeType: reusableAsset.mimeType,
      storageKey,
      storageUrl: buildStorageUrl(storageKey),
      fileSizeBytes: reusableAsset.fileSizeBytes,
      status: SourceAssetStatus.UPLOADED,
      retentionStatus: project.isSaved
        ? MediaRetentionStatus.SAVED
        : MediaRetentionStatus.TEMPORARY,
      expiresAt: project.isSaved
        ? null
        : project.expiresAt || getTemporaryProjectExpiresAt(),
      savedAt: project.isSaved ? new Date() : null,
    })
    .returning();

  await createUploadCompletedNotification(sourceAsset.id);
  await enqueueTranscriptionJob(sourceAsset.id, user.id);
  triggerInternalJobProcessing();

  return {
    sourceAsset,
  };
}

export async function getReusableFontAssetForUser(
  assetId: number | null | undefined,
  userId: number
) {
  if (!assetId) {
    return null;
  }

  const asset = await getReusableAssetForUser(assetId, userId);

  if (!asset || asset.kind !== ReusableAssetKind.FONT) {
    throw new Error('Caption font asset not found.');
  }

  return asset;
}

export async function deleteReusableAssetForUser(assetId: number, userId: number) {
  const [deletedAsset] = await db
    .delete(reusableAssets)
    .where(and(eq(reusableAssets.id, assetId), eq(reusableAssets.userId, userId)))
    .returning();

  if (!deletedAsset) {
    return null;
  }

  await deleteStorageObject(deletedAsset.storageKey).catch(() => undefined);

  return deletedAsset;
}

export async function getReusableAssetDownload(
  assetId: number,
  userId: number,
  expiresInSeconds = 3600
) {
  const asset = await getReusableAssetForUser(assetId, userId);

  if (!asset) {
    throw new Error('Reusable asset not found.');
  }

  return {
    asset,
    download: createPresignedDownload({
      storageKey: asset.storageKey,
      expiresInSeconds,
    }),
  };
}
