import { JobRecoveryOutcome } from '@/lib/db/schema';

export type JobRecoveryApiResult = {
  outcome?: string;
  code?: string;
  successorJobId?: number | null;
};

export function isAcceptedRecoveryResult(
  result: JobRecoveryApiResult
): result is JobRecoveryApiResult & { successorJobId: number } {
  return (
    result.outcome === JobRecoveryOutcome.ACCEPTED &&
    Number.isInteger(result.successorJobId) &&
    (result.successorJobId ?? 0) > 0
  );
}

export async function submitJobRecovery(params: {
  jobId: number;
  mode: string;
  idempotencyKey: string;
  expectedCurrentGeneration?: string | null;
  fetcher?: typeof fetch;
}) {
  const response = await (params.fetcher ?? fetch)(`/api/jobs/${params.jobId}/recover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: params.mode,
      idempotencyKey: params.idempotencyKey,
      ...(params.expectedCurrentGeneration
        ? { expectedCurrentGeneration: params.expectedCurrentGeneration }
        : {}),
    }),
  });
  const result = await response.json().catch(() => ({})) as JobRecoveryApiResult;
  if (!response.ok || !isAcceptedRecoveryResult(result)) {
    throw new Error(result.code || 'Recovery could not be queued.');
  }
  return result;
}
