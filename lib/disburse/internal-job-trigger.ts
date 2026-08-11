import 'server-only';
import { randomUUID } from 'node:crypto';
import { classifyOperationalFailure, emitOperationalEvent } from '@/lib/disburse/operational-events';
import { recordOperationalSignal } from '@/lib/disburse/operational-signal-service';

import { after } from 'next/server';
import { headers } from 'next/headers';

function getInternalProcessingSecret() {
  const value = process.env.INTERNAL_PROCESSING_SECRET?.trim();

  if (!value) {
    throw new Error('INTERNAL_PROCESSING_SECRET environment variable is not set.');
  }

  return value;
}

export function isDedicatedWorkerProcessorMode() {
  return process.env.DISBURSE_PROCESSOR_MODE?.trim() === 'worker';
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

type InternalJobProcessingTriggerDependencies = {
  schedule?: (callback: () => Promise<void>) => void;
  post?: () => Promise<void>;
};

export function triggerInternalJobProcessing(
  dependencies: InternalJobProcessingTriggerDependencies = {}
) {
  if (isDedicatedWorkerProcessorMode()) return;
  const schedule = dependencies.schedule ?? after;
  const post = dependencies.post ?? postInternalJobProcessingTrigger;
  schedule(async () => {
    try {
      await post();
    } catch (error) {
      await recordOperationalSignal({
        signalType: 'internal_trigger_failure',
        failureClass: classifyOperationalFailure(error).failureClass,
      }).catch(() => undefined);
      emitOperationalEvent('pipeline.scheduler_signal', {
        invocationId: randomUUID(),
        origin: 'internal',
        schedulerSignal: 'trigger_failed',
        ...classifyOperationalFailure(error),
      });
    }
  });
}
