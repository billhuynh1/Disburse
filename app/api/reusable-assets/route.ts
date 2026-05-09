import { getUser } from '@/lib/db/queries';
import {
  deleteReusableAssetForUser,
  listReusableAssetsForUser,
} from '@/lib/disburse/reusable-asset-service';

export async function GET() {
  const user = await getUser();

  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const assets = await listReusableAssetsForUser(user.id);
    return Response.json({ assets });
  } catch (error) {
    console.error('Unable to load reusable assets.', error);
    return Response.json(
      { error: 'Unable to load reusable assets.' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  const user = await getUser();

  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const assetId = Number(new URL(request.url).searchParams.get('id'));

  if (!Number.isInteger(assetId) || assetId <= 0) {
    return Response.json({ error: 'Invalid reusable asset id.' }, { status: 400 });
  }

  try {
    const deletedAsset = await deleteReusableAssetForUser(assetId, user.id);

    if (!deletedAsset) {
      return Response.json({ error: 'Reusable asset not found.' }, { status: 404 });
    }

    return Response.json({ success: true, asset: deletedAsset });
  } catch (error) {
    console.error('Unable to delete reusable asset.', error);
    return Response.json(
      { error: 'Unable to delete reusable asset.' },
      { status: 500 }
    );
  }
}
