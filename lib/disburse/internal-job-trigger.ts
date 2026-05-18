import 'server-only';

import { after } from 'next/server';
import { headers } from 'next/headers';

function getInternalProcessingSecret() {
  const value = process.env.INTERNAL_PROCESSING_SECRET?.trim();

  if (!value) {
    throw new Error('INTERNAL_PROCESSING_SECRET environment variable is not set.');
  }

  return value;
}

async function getRequestBaseUrl() {
  try {
    const requestHeaders = await headers();
    const host =
      requestHeaders.get('x-forwarded-host')?.trim() ||
      requestHeaders.get('host')?.trim();

    if (!host) {
      return null;
    }

    const proto =
      requestHeaders.get('x-forwarded-proto')?.trim() ||
      (host.includes('localhost') || host.startsWith('127.0.0.1')
        ? 'http'
        : 'https');

    return `${proto}://${host}`.replace(/\/$/, '');
  } catch {
    return null;
  }
}

async function getInternalProcessingBaseUrl() {
  const requestBaseUrl = await getRequestBaseUrl();

  if (requestBaseUrl) {
    return requestBaseUrl;
  }

  const configuredBaseUrl =
    process.env.BASE_URL?.trim() ||
    process.env.APP_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim();

  if (configuredBaseUrl) {
    return configuredBaseUrl.replace(/\/$/, '');
  }

  const vercelUrl = process.env.VERCEL_URL?.trim();

  if (vercelUrl) {
    return `https://${vercelUrl.replace(/\/$/, '')}`;
  }

  if (process.env.NODE_ENV !== 'production') {
    return `http://localhost:${process.env.PORT?.trim() || '3000'}`;
  }

  throw new Error('BASE_URL environment variable is not set.');
}

async function postInternalJobProcessingTrigger() {
  const baseUrl = await getInternalProcessingBaseUrl();
  const response = await fetch(
    `${baseUrl}/api/internal/jobs/process`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${getInternalProcessingSecret()}`
      },
      cache: 'no-store'
    }
  );

  if (response.ok) {
    return;
  }

  const body = await response.json().catch(() => null);
  const message =
    typeof body?.error === 'string' && body.error.trim().length > 0
      ? body.error
      : 'Failed to trigger internal job processing.';

  throw new Error(message);
}

export function triggerInternalJobProcessing() {
  after(async () => {
    try {
      await postInternalJobProcessingTrigger();
    } catch (error) {
      console.error('Failed to trigger internal job processing.', error);
    }
  });
}
