import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCronProcessJobsHandler,
} from '../../app/api/cron/process-jobs/route.ts';
import {
  createInternalProcessJobsHandler,
} from '../../app/api/internal/jobs/process/route.ts';
import type { PipelineProcessorResult } from './pipeline-processor-service.ts';

function result(
  stopReason: PipelineProcessorResult['stopReason'] = 'queue_empty'
): PipelineProcessorResult {
  return {
    invocationId: '00000000-0000-4000-8000-000000000000',
    durationMs: 1,
    stopReason,
    processedJobs: 0,
    recoveredJobs: 0,
    reconciledProjects: 0,
    reconciliationCycle: null,
    followUpTriggered: false,
  };
}

test('cron processing is inert in dedicated worker mode', async () => {
  const mutableEnv = process.env as unknown as Record<string, string | undefined>;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousCronSecret = process.env.CRON_SECRET;
  const previousMode = process.env.DISBURSE_PROCESSOR_MODE;
  try {
    mutableEnv.NODE_ENV = 'production';
    process.env.CRON_SECRET = 'cron-secret';
    process.env.DISBURSE_PROCESSOR_MODE = 'worker';
    let calls = 0;
    const GET = createCronProcessJobsHandler({
      processor: async () => {
        calls += 1;
        return result();
      },
    });

    const response = await GET(new Request('https://app.invalid/api/cron/process-jobs', {
      headers: { authorization: 'Bearer cron-secret' },
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'disabled', reason: 'dedicated_worker_mode',
    });
    assert.equal(calls, 0);
  } finally {
    if (previousNodeEnv === undefined) delete mutableEnv.NODE_ENV;
    else mutableEnv.NODE_ENV = previousNodeEnv;
    if (previousCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousCronSecret;
    if (previousMode === undefined) delete process.env.DISBURSE_PROCESSOR_MODE;
    else process.env.DISBURSE_PROCESSOR_MODE = previousMode;
  }
});

test('cron processing continues to invoke the processor outside worker mode', async () => {
  const mutableEnv = process.env as unknown as Record<string, string | undefined>;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousCronSecret = process.env.CRON_SECRET;
  const previousMode = process.env.DISBURSE_PROCESSOR_MODE;
  try {
    mutableEnv.NODE_ENV = 'production';
    process.env.CRON_SECRET = 'cron-secret';
    delete process.env.DISBURSE_PROCESSOR_MODE;
    const calls: Array<{ origin: 'cron'; invocationId: string }> = [];
    const expected = result();
    const GET = createCronProcessJobsHandler({
      processor: async (options) => {
        calls.push(options);
        return expected;
      },
    });

    const response = await GET(new Request('https://app.invalid/api/cron/process-jobs', {
      headers: { authorization: 'Bearer cron-secret' },
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expected);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].origin, 'cron');
  } finally {
    if (previousNodeEnv === undefined) delete mutableEnv.NODE_ENV;
    else mutableEnv.NODE_ENV = previousNodeEnv;
    if (previousCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousCronSecret;
    if (previousMode === undefined) delete process.env.DISBURSE_PROCESSOR_MODE;
    else process.env.DISBURSE_PROCESSOR_MODE = previousMode;
  }
});

test('the authenticated internal diagnostic route remains available in worker mode', async () => {
  const previousSecret = process.env.INTERNAL_PROCESSING_SECRET;
  const previousMode = process.env.DISBURSE_PROCESSOR_MODE;
  try {
    process.env.INTERNAL_PROCESSING_SECRET = 'internal-secret';
    process.env.DISBURSE_PROCESSOR_MODE = 'worker';
    const calls: Array<{ origin: 'internal'; invocationId: string }> = [];
    const POST = createInternalProcessJobsHandler({
      processor: async (options) => {
        calls.push(options);
        return result();
      },
    });

    const response = await POST(new Request('https://app.invalid/api/internal/jobs/process', {
      method: 'POST', headers: { authorization: 'Bearer internal-secret' },
    }));

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].origin, 'internal');
  } finally {
    if (previousSecret === undefined) delete process.env.INTERNAL_PROCESSING_SECRET;
    else process.env.INTERNAL_PROCESSING_SECRET = previousSecret;
    if (previousMode === undefined) delete process.env.DISBURSE_PROCESSOR_MODE;
    else process.env.DISBURSE_PROCESSOR_MODE = previousMode;
  }
});
