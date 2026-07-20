import {
  runPipelineProcessor,
} from '@/lib/disburse/pipeline-processor-service';
import { randomUUID } from 'node:crypto';
import { classifyOperationalFailure, emitOperationalEvent } from '@/lib/disburse/operational-events';
import { runWithOperationalFaultAuthorization } from '@/lib/disburse/fault-injection';

export const dynamic = 'force-dynamic';
export const maxDuration = 800;

function getInternalProcessingSecret() {
  const value = process.env.INTERNAL_PROCESSING_SECRET?.trim();
  if (!value) throw new Error('INTERNAL_PROCESSING_SECRET is not configured.');
  return value;
}

export async function POST(request: Request) {
  const invocationId = randomUUID();
  try {
    if (request.headers.get('authorization') !== `Bearer ${getInternalProcessingSecret()}`) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const result = await runWithOperationalFaultAuthorization(
      request.headers.get('x-disburse-fault-injection-authorization'),
      async () => await runPipelineProcessor({ origin: 'internal', invocationId })
    );
    if (result.stopReason === 'fatal_error') {
      return Response.json({ error: 'Pipeline processing failed.', invocationId }, { status: 500 });
    }
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    emitOperationalEvent('pipeline.invocation_failed', {
      invocationId, origin: 'internal', stopReason: 'fatal_error',
      ...classifyOperationalFailure(error),
    });
    return Response.json({ error: 'Pipeline processing failed.', invocationId }, { status: 500 });
  }
}
