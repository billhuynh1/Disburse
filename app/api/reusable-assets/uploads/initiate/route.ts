import { getUser } from '@/lib/db/queries';
import {
  initiateReusableAssetUpload,
  initiateReusableAssetUploadSchema,
} from '@/lib/disburse/reusable-asset-service';

export async function POST(request: Request) {
  const user = await getUser();

  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsedBody = initiateReusableAssetUploadSchema.safeParse(body);

  if (!parsedBody.success) {
    return Response.json(
      { error: parsedBody.error.errors[0]?.message || 'Invalid upload request.' },
      { status: 400 }
    );
  }

  try {
    const upload = await initiateReusableAssetUpload(parsedBody.data, user);
    return Response.json(upload);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to initiate upload.';

    return Response.json({ error: message }, { status: 400 });
  }
}
