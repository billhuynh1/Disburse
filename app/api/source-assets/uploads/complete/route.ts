import { getUser } from '@/lib/db/queries';
import {
  completeSourceAssetUpload,
  completeSourceAssetUploadSchema,
} from '@/lib/disburse/source-asset-upload-service';

export async function POST(request: Request) {
  const user = await getUser();

  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsedBody = completeSourceAssetUploadSchema.safeParse(body);

  if (!parsedBody.success) {
    return Response.json(
      {
        error:
          parsedBody.error.errors[0]?.message || 'Invalid upload completion request.',
      },
      { status: 400 }
    );
  }

  try {
    const result = await completeSourceAssetUpload(parsedBody.data, user);
    return Response.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to complete upload.';
    const status = message === 'Project not found.' ? 404 : 400;

    return Response.json({ error: message }, { status });
  }
}
