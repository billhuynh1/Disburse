import { getUser } from '@/lib/db/queries';
import {
  copyReusableMediaAssetToProject,
  useReusableAssetInProjectSchema,
} from '@/lib/disburse/reusable-asset-service';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getUser();

  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const assetId = Number(id);

  if (!Number.isInteger(assetId) || assetId <= 0) {
    return Response.json({ error: 'Invalid reusable asset id.' }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  const parsedBody = useReusableAssetInProjectSchema.safeParse(body);

  if (!parsedBody.success) {
    return Response.json(
      { error: parsedBody.error.errors[0]?.message || 'Invalid project request.' },
      { status: 400 }
    );
  }

  try {
    const result = await copyReusableMediaAssetToProject(
      assetId,
      parsedBody.data,
      user
    );

    return Response.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unable to use reusable asset.';
    const status =
      message === 'Reusable asset not found.' || message === 'Project not found.'
        ? 404
        : 400;

    return Response.json({ error: message }, { status });
  }
}
