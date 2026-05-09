import {
  getReusableAssetDownload,
} from '@/lib/disburse/reusable-asset-service';
import { getUser } from '@/lib/db/queries';
import { fetchPresignedAsset } from '@/lib/disburse/storage-proxy';

function formatReusableAssetFilename(filename: string) {
  return filename
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'reusable-asset';
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getUser();

  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const assetId = Number(id);

  if (!Number.isInteger(assetId) || assetId <= 0) {
    return Response.json({ error: 'Invalid reusable asset id.' }, { status: 400 });
  }

  try {
    const { asset, download } = await getReusableAssetDownload(assetId, user.id);
    const shouldDownload =
      new URL(request.url).searchParams.get('download') === '1';

    if (!shouldDownload) {
      return Response.redirect(download.downloadUrl, 307);
    }

    const storageFetch = await fetchPresignedAsset({
      url: download.downloadUrl,
      method: download.method,
      failureLabel: 'Reusable asset',
      logContext: {
        reusableAssetId: asset.id,
        userId: user.id,
      },
    });

    if (!storageFetch.ok) {
      return storageFetch.errorResponse;
    }

    const storageResponse = storageFetch.response;

    if (!storageResponse.ok) {
      return Response.json(
        { error: 'Reusable asset could not be downloaded.' },
        { status: storageResponse.status || 502 }
      );
    }

    const headers = new Headers();
    const contentType = asset.mimeType || storageResponse.headers.get('content-type');
    const contentLength = storageResponse.headers.get('content-length');

    if (contentType) {
      headers.set('content-type', contentType);
    }

    if (contentLength) {
      headers.set('content-length', contentLength);
    }

    headers.set(
      'content-disposition',
      `attachment; filename="${formatReusableAssetFilename(asset.originalFilename)}"`
    );
    headers.set('cache-control', 'private, max-age=300');

    return new Response(storageResponse.body, {
      status: storageResponse.status,
      headers,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Reusable asset not found.';
    const status = message === 'Reusable asset not found.' ? 404 : 400;

    return Response.json({ error: message }, { status });
  }
}
