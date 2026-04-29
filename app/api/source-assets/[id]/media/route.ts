import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { sourceAssets, SourceAssetType } from '@/lib/db/schema';
import { getUser } from '@/lib/db/queries';
import { createPresignedDownload } from '@/lib/disburse/s3-storage';
import { isMediaUnavailable } from '@/lib/disburse/media-retention-service';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getUser();

  if (!user) {
    return Response.json({ error: 'User not authenticated' }, { status: 401 });
  }

  const { id } = await params;
  const sourceAssetId = Number(id);

  if (!Number.isInteger(sourceAssetId) || sourceAssetId <= 0) {
    return Response.json({ error: 'Invalid source asset id.' }, { status: 400 });
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
    return Response.json({ error: 'Source asset media not found.' }, { status: 404 });
  }

  if (isMediaUnavailable(sourceAsset)) {
    return Response.json(
      { error: 'Source asset media expired and is no longer available.' },
      { status: 410 }
    );
  }

  const download = createPresignedDownload({
    storageKey: sourceAsset.storageKey,
    expiresInSeconds: 300,
  });
  const range = request.headers.get('range');
  const storageResponse = await fetch(download.downloadUrl, {
    method: download.method,
    headers: range ? { Range: range } : undefined,
  });

  if (!storageResponse.ok && storageResponse.status !== 206) {
    return Response.json(
      { error: 'Source asset media could not be loaded.' },
      { status: storageResponse.status || 502 }
    );
  }

  const headers = new Headers();
  const contentType = sourceAsset.mimeType || storageResponse.headers.get('content-type');
  const contentLength = storageResponse.headers.get('content-length');
  const contentRange = storageResponse.headers.get('content-range');

  if (contentType) {
    headers.set('content-type', contentType);
  }

  if (contentLength) {
    headers.set('content-length', contentLength);
  }

  if (contentRange) {
    headers.set('content-range', contentRange);
  }

  headers.set('accept-ranges', storageResponse.headers.get('accept-ranges') || 'bytes');
  headers.set('cache-control', 'private, max-age=300');

  return new Response(storageResponse.body, {
    status: storageResponse.status,
    headers,
  });
}
