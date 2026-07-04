import { getUser } from '@/lib/db/queries';
import {
  getSourceAssetUploadStatus,
  sourceAssetUploadSessionSchema,
} from '@/lib/disburse/source-asset-upload-service';

export async function POST(request: Request) {
  const user = await getUser();

  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsedBody = sourceAssetUploadSessionSchema.safeParse(body);

  if (!parsedBody.success) {
    return Response.json(
      { error: parsedBody.error.errors[0]?.message || 'Invalid status request.' },
      { status: 400 }
    );
  }

  try {
    return Response.json(await getSourceAssetUploadStatus(parsedBody.data, user));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load upload status.';
    const status = message === 'Upload session not found.' ? 404 : 400;
    return Response.json({ error: message }, { status });
  }
}
