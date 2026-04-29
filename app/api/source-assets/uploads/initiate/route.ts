import { getUser } from '@/lib/db/queries';
import {
  initiateSourceAssetUpload,
  initiateSourceAssetUploadSchema,
} from '@/lib/disburse/source-asset-upload-service';

export async function POST(request: Request) {
  const user = await getUser();

  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsedBody = initiateSourceAssetUploadSchema.safeParse(body);

  if (!parsedBody.success) {
    return Response.json(
      { error: parsedBody.error.errors[0]?.message || 'Invalid upload request.' },
      { status: 400 }
    );
  }

  try {
    const upload = await initiateSourceAssetUpload(parsedBody.data, user);
    return Response.json(upload);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to initiate upload.';
    const status = message === 'Project not found.' ? 404 : 400;
    const responseMessage =
      message === 'Project not found.'
        ? message
        : 'Unable to start this upload right now.';

    return Response.json({ error: responseMessage }, { status });
  }
}
