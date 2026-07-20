import 'server-only';
import { classifyOperationalFailure, emitOperationalEvent } from '@/lib/disburse/operational-events';
import { getOperationalCorrelation } from '@/lib/disburse/operational-context';

type FetchPresignedAssetInput = {
  url: string;
  method: string;
  headers?: HeadersInit;
  failureLabel: string;
  logContext: Record<string, string | number | null | undefined>;
};

export async function fetchPresignedAsset({
  url,
  method,
  headers,
  failureLabel,
  logContext,
}: FetchPresignedAssetInput) {
  try {
    return {
      ok: true as const,
      response: await fetch(url, {
        method,
        headers,
      }),
    };
  } catch (error) {
    emitOperationalEvent('pipeline.provider_boundary', {
      ...getOperationalCorrelation(),
      provider: 's3',
      boundary: 'fetch_failed',
      ...logContext,
      ...classifyOperationalFailure(error),
    });

    return {
      ok: false as const,
      errorResponse: Response.json(
        {
          error: `${failureLabel} could not be loaded because storage was unreachable.`,
        },
        { status: 502 }
      ),
    };
  }
}
