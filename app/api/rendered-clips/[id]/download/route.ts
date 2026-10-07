import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { renderedClips } from '@/lib/db/schema';
import { getUser } from '@/lib/db/queries';
import { createPresignedDownload } from '@/lib/disburse/s3-storage';
import { isMediaUnavailable } from '@/lib/disburse/media-retention-service';
import { assertRenderedClipPublicationAuthority } from '@/lib/disburse/publishing-service';
import { fetchPresignedAsset } from '@/lib/disburse/storage-proxy';

import { createRenderedClipDownloadRoute } from '@/lib/disburse/media-delivery-route-handlers';

export const GET = createRenderedClipDownloadRoute({
  getUser,
  createPresignedDownload,
  isMediaUnavailable,
  fetchPresignedAsset,
  async findRenderedClip(id, userId) {
    return await db.query.renderedClips.findFirst({
      where: and(eq(renderedClips.id, id), eq(renderedClips.userId, userId)),
    });
  },
  assertRenderedClipPublicationAuthority,
});
