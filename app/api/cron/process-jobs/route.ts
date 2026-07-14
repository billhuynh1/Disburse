import {
  runPipelineProcessor,
} from '@/lib/disburse/pipeline-processor-service';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 800;

function getCronSecret() {
  const value = process.env.CRON_SECRET?.trim();
  if (!value) throw new Error('CRON_SECRET is not configured.');
  return value;
}

export async function GET(request: Request) {
  if (process.env.NODE_ENV !== 'production') {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    if (request.headers.get('authorization') !== `Bearer ${getCronSecret()}`) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const result = await runPipelineProcessor({ origin: 'cron' });
    if (result.stopReason === 'fatal_error') {
      return Response.json({ error: 'Pipeline processing failed.' }, { status: 500 });
    }
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('cron_pipeline_route.failed', error);
    return Response.json({ error: 'Pipeline processing failed.' }, { status: 500 });
  }
}
