import {
  runPipelineProcessor,
} from '@/lib/disburse/pipeline-processor-service';
import { randomUUID } from 'node:crypto';
import { classifyOperationalFailure, emitOperationalEvent } from '@/lib/disburse/operational-events';

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

  const invocationId = randomUUID();
  try {
    if (request.headers.get('authorization') !== `Bearer ${getCronSecret()}`) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const result = await runPipelineProcessor({ origin: 'cron', invocationId });
    if (result.stopReason === 'fatal_error') {
      return Response.json({ error: 'Pipeline processing failed.', invocationId }, { status: 500 });
    }
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    emitOperationalEvent('pipeline.invocation_failed', {
      invocationId, origin: 'cron', stopReason: 'fatal_error',
      ...classifyOperationalFailure(error),
    });
    return Response.json({ error: 'Pipeline processing failed.', invocationId }, { status: 500 });
  }
}
