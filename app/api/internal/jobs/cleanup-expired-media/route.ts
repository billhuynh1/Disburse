import { cleanupExpiredTemporaryMedia } from '@/lib/disburse/media-retention-service';

function getInternalProcessingSecret() {
  const value = process.env.INTERNAL_PROCESSING_SECRET?.trim();

  if (!value) {
    throw new Error('INTERNAL_PROCESSING_SECRET environment variable is not set.');
  }

  return value;
}

function isAuthorized(request: Request) {
  const authorization = request.headers.get('authorization');
  return authorization === `Bearer ${getInternalProcessingSecret()}`;
}

export async function POST(request: Request) {
  try {
    if (!isAuthorized(request)) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const result = await cleanupExpiredTemporaryMedia();
    const status = result.errorCount > 0 ? 207 : 200;

    return Response.json(result, { status });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to clean up expired media.';

    return Response.json({ error: message }, { status: 500 });
  }
}
