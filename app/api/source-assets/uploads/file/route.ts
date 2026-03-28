import { getUser } from '@/lib/db/queries';
import {
  uploadSourceAssetFile,
  uploadSourceAssetFileSchema,
} from '@/lib/disburse/source-asset-upload-service';

function getSingleFormValue(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : null;
}

export async function POST(request: Request) {
  const user = await getUser();

  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const formData = await request.formData().catch(() => null);

  if (!formData) {
    return Response.json({ error: 'Invalid upload request.' }, { status: 400 });
  }

  const file = formData.get('file');
  const parsedBody = uploadSourceAssetFileSchema.safeParse({
    projectId: Number(getSingleFormValue(formData, 'projectId')),
    title: getSingleFormValue(formData, 'title'),
  });

  if (!parsedBody.success) {
    return Response.json(
      { error: parsedBody.error.errors[0]?.message || 'Invalid upload request.' },
      { status: 400 }
    );
  }

  if (!(file instanceof File)) {
    return Response.json(
      { error: 'Select an audio or video file to upload.' },
      { status: 400 }
    );
  }

  try {
    const result = await uploadSourceAssetFile(
      {
        ...parsedBody.data,
        file,
      },
      user
    );

    return Response.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to upload source asset.';
    const status = message === 'Project not found.' ? 404 : 400;

    return Response.json({ error: message }, { status });
  }
}
