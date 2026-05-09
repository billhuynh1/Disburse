import { getUser } from '@/lib/db/queries';
import {
  completeReusableAssetUpload,
  completeReusableAssetUploadSchema,
} from '@/lib/disburse/reusable-asset-service';

export async function POST(request: Request) {
  const user = await getUser();

  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsedBody = completeReusableAssetUploadSchema.safeParse(body);

  if (!parsedBody.success) {
    return Response.json(
      {
        error:
          parsedBody.error.errors[0]?.message ||
          'Invalid upload completion request.',
      },
      { status: 400 }
    );
  }

  try {
    const result = await completeReusableAssetUpload(parsedBody.data, user);
    return Response.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to complete upload.';

    return Response.json({ error: message }, { status: 400 });
  }
}
