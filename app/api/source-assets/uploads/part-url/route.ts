import { getUser } from '@/lib/db/queries';
import {
  createSourceAssetUploadPartUrl,
  sourceAssetUploadPartUrlSchema,
} from '@/lib/disburse/source-asset-upload-service';

export async function POST(request: Request) {
  const user = await getUser();

  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsedBody = sourceAssetUploadPartUrlSchema.safeParse(body);

  if (!parsedBody.success) {
    return Response.json(
      { error: parsedBody.error.errors[0]?.message || 'Invalid part request.' },
      { status: 400 }
    );
  }

  try {
    return Response.json(await createSourceAssetUploadPartUrl(parsedBody.data, user));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to create part upload URL.';
    const status = message === 'Upload session not found.' ? 404 : 400;
    return Response.json({ error: message }, { status });
  }
}
