import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { sourceAssets } from '@/lib/db/schema';
import { getUser } from '@/lib/db/queries';
import { createPresignedDownload } from '@/lib/disburse/s3-storage';
import { isMediaUnavailable } from '@/lib/disburse/media-retention-service';
import { fetchPresignedAsset } from '@/lib/disburse/storage-proxy';

import { createSourceMediaRoute } from '@/lib/disburse/media-delivery-route-handlers';

export const GET = createSourceMediaRoute({
  getUser,
  createPresignedDownload,
  isMediaUnavailable,
  fetchPresignedAsset,
  async findSourceAsset(id, userId) {
    return await db.query.sourceAssets.findFirst({
      where: and(eq(sourceAssets.id, id), eq(sourceAssets.userId, userId)),
    });
  },
});
