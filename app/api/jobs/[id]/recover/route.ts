import { getUser } from '@/lib/db/queries';
import { JobRecoveryOutcome } from '@/lib/db/schema';
import {
  persistInvalidRecoveryRequest,
  requestJobRecovery,
} from '@/lib/disburse/job-recovery-service';
import {
  buildSafeRecoveryAuditMetadata,
  readBoundedJsonBody,
  recoveryRequestBodySchema,
  RecoveryRequestBodyError,
} from '@/lib/disburse/recovery-request-body';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const user = await getUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const jobId = Number((await context.params).id);
  let raw: unknown;
  try {
    raw = await readBoundedJsonBody(request);
  } catch (error) {
    const code = error instanceof RecoveryRequestBodyError ? error.code : 'invalid_body';
    const result = await persistInvalidRecoveryRequest({
      idempotencyKey: request.headers.get('idempotency-key'),
      userId: user.id,
      jobId: Number.isInteger(jobId) && jobId > 0 ? jobId : null,
      code,
    });
    return Response.json(result, { status: code === 'body_too_large' ? 413 : 400 });
  }
  const parsed = recoveryRequestBodySchema.safeParse(raw);
  if (!parsed.success || !Number.isInteger(jobId) || jobId < 1) {
    const value = raw as Record<string, unknown> | null;
    const result = await persistInvalidRecoveryRequest({
      idempotencyKey: value?.idempotencyKey,
      userId: user.id,
      jobId: Number.isInteger(jobId) && jobId > 0 ? jobId : null,
      mode: typeof value?.mode === 'string' ? value.mode : null,
      code: 'invalid_request',
      safeMetadata: buildSafeRecoveryAuditMetadata(raw),
    });
    return Response.json(result, { status: 400 });
  }
  const result = await requestJobRecovery({
    ...parsed.data,
    userId: user.id,
    jobId,
    requestedBy: 'user',
  });
  return Response.json(result, {
    status: result.outcome === JobRecoveryOutcome.ACCEPTED ? 200 : 409,
  });
}
