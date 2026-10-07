import { SourceAssetType, type SourceAsset, type RenderedClip } from '../db/schema.ts';

type RouteContext = { params: Promise<{ id: string }> };
type StorageResult = { ok: true; response: Response } | { ok: false; errorResponse: Response };
type CommonDeps = {
  getUser: () => Promise<{ id: number } | null>;
  createPresignedDownload: (input: { storageKey: string; expiresInSeconds: number }) => { downloadUrl: string; method: string };
  isMediaUnavailable: (asset: SourceAsset | RenderedClip) => boolean;
  fetchPresignedAsset: (input: { url: string; method: string; headers?: Record<string, string>; failureLabel: string; logContext: Record<string, number> }) => Promise<StorageResult>;
};

export function createSourceMediaRoute(deps: CommonDeps & {
  findSourceAsset: (id: number, userId: number) => Promise<SourceAsset | undefined>;
}) {
  return async function GET(request: Request, { params }: RouteContext) {
    const user = await deps.getUser();

    if (!user) {
      return Response.json({ error: 'User not authenticated' }, { status: 401 });
    }

    const { id } = await params;
    const sourceAssetId = Number(id);

    if (!Number.isInteger(sourceAssetId) || sourceAssetId <= 0) {
      return Response.json({ error: 'Invalid source asset id.' }, { status: 400 });
    }

    const sourceAsset = await deps.findSourceAsset(sourceAssetId, user.id);

    if (
      !sourceAsset ||
      sourceAsset.assetType !== SourceAssetType.UPLOADED_FILE ||
      !sourceAsset.storageKey
    ) {
      return Response.json({ error: 'Source asset media not found.' }, { status: 404 });
    }

    if (deps.isMediaUnavailable(sourceAsset)) {
      return Response.json(
        { error: 'Source asset media expired and is no longer available.' },
        { status: 410 }
      );
    }

    const download = deps.createPresignedDownload({
      storageKey: sourceAsset.storageKey,
      expiresInSeconds: 300,
    });
    const range = request.headers.get('range');
    const storageFetch = await deps.fetchPresignedAsset({
      url: download.downloadUrl,
      method: download.method,
      headers: range ? { Range: range } : undefined,
      failureLabel: 'Source asset media',
      logContext: {
        sourceAssetId: sourceAsset.id,
        userId: user.id,
      },
    });

    if (!storageFetch.ok) {
      return storageFetch.errorResponse;
    }

    const storageResponse = storageFetch.response;

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
  };
}
export function createRenderedClipDownloadRoute(deps: CommonDeps & {
  findRenderedClip: (id: number, userId: number) => Promise<RenderedClip | undefined>;
  assertRenderedClipPublicationAuthority: (input: { renderedClipId: number; userId: number }) => Promise<unknown>;
}) {
  return async function GET(request: Request, { params }: RouteContext) {
    const user = await deps.getUser();

    if (!user) {
      return Response.json({ error: 'User not authenticated' }, { status: 401 });
    }

    const { id } = await params;
    const renderedClipId = Number(id);

    if (!Number.isInteger(renderedClipId) || renderedClipId <= 0) {
      return Response.json({ error: 'Invalid rendered clip id.' }, { status: 400 });
    }

    const renderedClip = await deps.findRenderedClip(renderedClipId, user.id);

    if (!renderedClip || !renderedClip.storageKey) {
      return Response.json({ error: 'Rendered clip not found.' }, { status: 404 });
    }

    if (renderedClip.status !== 'ready') {
      return Response.json(
        { error: 'Rendered clip is not ready yet.' },
        { status: 409 }
      );
    }

    try {
      await deps.assertRenderedClipPublicationAuthority({
        renderedClipId: renderedClip.id,
        userId: user.id,
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : 'Rendered clip is not available.' },
        { status: 409 }
      );
    }

    if (deps.isMediaUnavailable(renderedClip)) {
      return Response.json(
        { error: 'Rendered clip media expired and is no longer available.' },
        { status: 410 }
      );
    }

    const download = deps.createPresignedDownload({
      storageKey: renderedClip.storageKey,
      expiresInSeconds: 3600,
    });
    const shouldDownload =
      new URL(request.url).searchParams.get('download') === '1';

    if (shouldDownload) {
      const storageFetch = await deps.fetchPresignedAsset({
        url: download.downloadUrl,
        method: download.method,
        failureLabel: 'Rendered clip media',
        logContext: {
          renderedClipId: renderedClip.id,
          userId: user.id,
        },
      });

      if (!storageFetch.ok) {
        return storageFetch.errorResponse;
      }

      const storageResponse = storageFetch.response;

      if (!storageResponse.ok) {
        return Response.json(
          { error: 'Rendered clip media could not be downloaded.' },
          { status: storageResponse.status || 502 }
        );
      }

      const headers = new Headers();
      const contentType =
        renderedClip.mimeType || storageResponse.headers.get('content-type');
      const contentLength = storageResponse.headers.get('content-length');

      if (contentType) {
        headers.set('content-type', contentType);
      }

      if (contentLength) {
        headers.set('content-length', contentLength);
      }

      headers.set(
        'content-disposition',
        `attachment; filename="${formatRenderedClipFilename(renderedClip.title)}"`
      );
      headers.set('cache-control', 'private, max-age=300');

      return new Response(storageResponse.body, {
        status: storageResponse.status,
        headers,
      });
    }

    return Response.redirect(download.downloadUrl, 307);

  };
}

function formatRenderedClipFilename(title: string) {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return `${slug || 'rendered-clip'}-hd.mp4`;
}
