import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { renderedClips } from '@/lib/db/schema';
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
  const renderedClipId = Number(id);

  if (!Number.isInteger(renderedClipId) || renderedClipId <= 0) {
    return Response.json({ error: 'Invalid rendered clip id.' }, { status: 400 });
  }

  const renderedClip = await db.query.renderedClips.findFirst({
    where: and(
      eq(renderedClips.id, renderedClipId),
      eq(renderedClips.userId, user.id)
    ),
  });

  if (!renderedClip || !renderedClip.storageKey) {
    return Response.json({ error: 'Rendered clip not found.' }, { status: 404 });
  }

  if (renderedClip.status !== 'ready') {
    return Response.json(
      { error: 'Rendered clip is not ready yet.' },
      { status: 409 }
    );
  }

  if (isMediaUnavailable(renderedClip)) {
    return Response.json(
      { error: 'Rendered clip media expired and is no longer available.' },
      { status: 410 }
    );
  }

  const download = createPresignedDownload({
    storageKey: renderedClip.storageKey,
    expiresInSeconds: 3600,
  });
  const shouldDownload =
    new URL(request.url).searchParams.get('download') === '1';

  if (shouldDownload) {
    const storageResponse = await fetch(download.downloadUrl, {
      method: download.method,
    });

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
