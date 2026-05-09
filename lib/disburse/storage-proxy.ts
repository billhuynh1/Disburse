import 'server-only';

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
    const target = safeParseUrl(url);

    console.error(`${failureLabel} storage fetch failed.`, {
      ...logContext,
      storageUrl: url,
      storageHost: target?.host ?? null,
      storageOrigin: target?.origin ?? null,
      error,
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

function safeParseUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
