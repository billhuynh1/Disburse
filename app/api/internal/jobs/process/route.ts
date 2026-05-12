import { processNextJob } from '@/lib/disburse/pipeline-service';
import { recoverStalledPipelineJobs } from '@/lib/disburse/job-service';

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

    await recoverStalledPipelineJobs();
    const result = await processNextJob();
    return Response.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to process jobs.';

    return Response.json({ error: message }, { status: 500 });
  }
}
