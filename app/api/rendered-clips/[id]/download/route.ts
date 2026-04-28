import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { renderedClips } from '@/lib/db/schema';
import { getUser } from '@/lib/db/queries';
import { createPresignedDownload } from '@/lib/disburse/s3-storage';
import { isMediaUnavailable } from '@/lib/disburse/media-retention-service';

export async function GET(
  _request: Request,
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

  return Response.redirect(download.downloadUrl, 307);
}
