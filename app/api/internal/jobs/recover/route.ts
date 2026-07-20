import { z } from 'zod';

import { JobRecoveryMode, JobRecoveryOutcome } from '@/lib/db/schema';
import {
  persistInvalidRecoveryRequest,
  requestJobRecovery,
} from '@/lib/disburse/job-recovery-service';
import {
  buildSafeRecoveryAuditMetadata,
  readBoundedJsonBody,
  RecoveryRequestBodyError,
} from '@/lib/disburse/recovery-request-body';

const operatorBodySchema = z.object({
  userId: z.number().int().positive(),
  jobId: z.number().int().positive(),
  mode: z.nativeEnum(JobRecoveryMode),
  idempotencyKey: z.string().trim().min(1).max(200),
  expectedCurrentGeneration: z.string().trim().min(1).max(200).optional(),
}).strict();

function isAuthorized(request: Request) {
  const secret = process.env.INTERNAL_PROCESSING_SECRET?.trim();
  return Boolean(secret) && request.headers.get('authorization') === `Bearer ${secret}`;
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  let raw: unknown;
  try {
    raw = await readBoundedJsonBody(request);
  } catch (error) {
    const code = error instanceof RecoveryRequestBodyError ? error.code : 'invalid_body';
    const result = await persistInvalidRecoveryRequest({
      idempotencyKey: request.headers.get('idempotency-key'),
      code,
    });
    return Response.json(result, { status: code === 'body_too_large' ? 413 : 400 });
  }
  const parsed = operatorBodySchema.safeParse(raw);
  if (!parsed.success) {
    const value = raw as Record<string, unknown> | null;
    const result = await persistInvalidRecoveryRequest({
      idempotencyKey: value?.idempotencyKey,
      userId: typeof value?.userId === 'number' ? value.userId : null,
      jobId: typeof value?.jobId === 'number' ? value.jobId : null,
      mode: typeof value?.mode === 'string' ? value.mode : null,
      code: 'invalid_request',
      safeMetadata: buildSafeRecoveryAuditMetadata(raw),
    });
    return Response.json(result, { status: 400 });
  }
  const result = await requestJobRecovery({ ...parsed.data, requestedBy: 'operator' });
  return Response.json(result, {
    status: result.outcome === JobRecoveryOutcome.ACCEPTED ? 200 : 409,
  });
}
