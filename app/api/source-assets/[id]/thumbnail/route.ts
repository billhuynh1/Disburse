import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db/drizzle';
import { getUser } from '@/lib/db/queries';
import {
  sourceAssets,
  SourceAssetType,
} from '@/lib/db/schema';
import {
  createPresignedDownload,
  createSourceAssetThumbnailStorageKey,
  deleteStorageObject,
  uploadStorageObject,
} from '@/lib/disburse/s3-storage';
import { isMediaUnavailable } from '@/lib/disburse/media-retention-service';
import { fetchPresignedAsset } from '@/lib/disburse/storage-proxy';

const MAX_THUMBNAIL_SIZE_BYTES = 2 * 1024 * 1024;
const thumbnailMimeTypes = ['image/jpeg', 'image/webp'] as const;

const thumbnailMetadataSchema = z.object({
  width: z.coerce.number().int().positive().max(10000),
  height: z.coerce.number().int().positive().max(10000),
});

function parseSourceAssetId(id: string) {
  const sourceAssetId = Number(id);

  if (!Number.isInteger(sourceAssetId) || sourceAssetId <= 0) {
    return null;
  }

  return sourceAssetId;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getUser();

  if (!user) {
    return Response.json({ error: 'User not authenticated' }, { status: 401 });
  }

  const { id } = await params;
  const sourceAssetId = parseSourceAssetId(id);

  if (!sourceAssetId) {
    return Response.json({ error: 'Invalid source asset id.' }, { status: 400 });
  }

  const sourceAsset = await db.query.sourceAssets.findFirst({
    where: and(
      eq(sourceAssets.id, sourceAssetId),
      eq(sourceAssets.userId, user.id)
    ),
  });

  if (!sourceAsset?.thumbnailStorageKey) {
    return Response.json({ error: 'Source asset thumbnail not found.' }, { status: 404 });
  }

  if (isMediaUnavailable(sourceAsset)) {
    return Response.json(
      { error: 'Source asset media expired and is no longer available.' },
      { status: 410 }
    );
  }

  const download = createPresignedDownload({
    storageKey: sourceAsset.thumbnailStorageKey,
    expiresInSeconds: 300,
  });
  const storageFetch = await fetchPresignedAsset({
    url: download.downloadUrl,
    method: download.method,
    failureLabel: 'Source asset thumbnail',
    logContext: {
      sourceAssetId: sourceAsset.id,
      userId: user.id,
    },
  });

  if (!storageFetch.ok) {
    return storageFetch.errorResponse;
  }

  const storageResponse = storageFetch.response;

  if (!storageResponse.ok) {
    return Response.json(
      { error: 'Source asset thumbnail could not be loaded.' },
      { status: storageResponse.status || 502 }
    );
  }

  const headers = new Headers();
  headers.set(
    'content-type',
    sourceAsset.thumbnailMimeType ||
      storageResponse.headers.get('content-type') ||
      'image/jpeg'
  );
  headers.set('cache-control', 'private, max-age=300');

  const contentLength = storageResponse.headers.get('content-length');
  if (contentLength) {
    headers.set('content-length', contentLength);
  }

  return new Response(storageResponse.body, {
    status: storageResponse.status,
    headers,
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getUser();

  if (!user) {
    return Response.json({ error: 'User not authenticated' }, { status: 401 });
  }

  const { id } = await params;
  const sourceAssetId = parseSourceAssetId(id);

  if (!sourceAssetId) {
    return Response.json({ error: 'Invalid source asset id.' }, { status: 400 });
  }

  const formData = await request.formData().catch(() => null);

  if (!formData) {
    return Response.json({ error: 'Invalid thumbnail upload.' }, { status: 400 });
  }

  const file = formData.get('file');
  const parsedMetadata = thumbnailMetadataSchema.safeParse({
    width: formData.get('width'),
    height: formData.get('height'),
  });

  if (!(file instanceof File) || !parsedMetadata.success) {
    return Response.json({ error: 'Invalid thumbnail upload.' }, { status: 400 });
  }

  if (
    !thumbnailMimeTypes.includes(file.type as (typeof thumbnailMimeTypes)[number]) ||
    file.size <= 0 ||
    file.size > MAX_THUMBNAIL_SIZE_BYTES
  ) {
    return Response.json({ error: 'Unsupported thumbnail image.' }, { status: 400 });
  }

  const sourceAsset = await db.query.sourceAssets.findFirst({
    where: and(
      eq(sourceAssets.id, sourceAssetId),
      eq(sourceAssets.userId, user.id)
    ),
  });

  if (
    !sourceAsset ||
    sourceAsset.assetType !== SourceAssetType.UPLOADED_FILE ||
    !sourceAsset.storageKey
  ) {
    return Response.json({ error: 'Source asset not found.' }, { status: 404 });
  }

  if (isMediaUnavailable(sourceAsset)) {
    return Response.json(
      { error: 'Source asset media expired and is no longer available.' },
      { status: 410 }
    );
  }

  const previousThumbnailStorageKey = sourceAsset.thumbnailStorageKey;
  const thumbnailStorageKey = createSourceAssetThumbnailStorageKey({
    userId: user.id,
    projectId: sourceAsset.projectId,
    sourceAssetId: sourceAsset.id,
    mimeType: file.type,
  });

  await uploadStorageObject({
    storageKey: thumbnailStorageKey,
    mimeType: file.type,
    body: Buffer.from(await file.arrayBuffer()),
  });

  const now = new Date();
  const [updatedSourceAsset] = await db
    .update(sourceAssets)
    .set({
      thumbnailStorageKey,
      thumbnailMimeType: file.type,
      thumbnailWidth: parsedMetadata.data.width,
      thumbnailHeight: parsedMetadata.data.height,
      updatedAt: now,
    })
    .where(and(eq(sourceAssets.id, sourceAsset.id), eq(sourceAssets.userId, user.id)))
    .returning();

  if (previousThumbnailStorageKey && previousThumbnailStorageKey !== thumbnailStorageKey) {
    await deleteStorageObject(previousThumbnailStorageKey).catch(() => undefined);
  }

  return Response.json({
    sourceAsset: updatedSourceAsset,
  });
}
