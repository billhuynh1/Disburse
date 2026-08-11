import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PipelineWorker,
  type PipelineWorkerOptions,
} from '../../workers/pipeline-worker.ts';
import { triggerInternalJobProcessing } from './internal-job-trigger.ts';
import type { PipelineProcessorResult } from './pipeline-processor-service.ts';

function result(
  stopReason: PipelineProcessorResult['stopReason'],
  processedJobs = 0
): PipelineProcessorResult {
  return {
    invocationId: '00000000-0000-4000-8000-000000000000',
    durationMs: 1,
    stopReason,
    processedJobs,
    recoveredJobs: 0,
    reconciledProjects: 0,
    reconciliationCycle: null,
    followUpTriggered: false,
  };
}

function quietWorker(options: PipelineWorkerOptions) {
  return new PipelineWorker({
    ...options,
    logger: { info: () => undefined, error: () => undefined },
  });
}

test('worker independently reuses the pipeline processor across idle and new-work transitions', async () => {
  const results = [result('queue_empty'), result('max_jobs', 1), result('queue_empty')];
  const calls: Array<{ origin: 'internal'; enableFollowUp: false }> = [];
  let worker: PipelineWorker;
  let sleeps = 0;
  worker = quietWorker({
    processor: async (options) => {
      calls.push(options);
      return results.shift()!;
    },
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 2) worker.requestShutdown();
    },
  });

  await worker.run();

  assert.equal(calls.length, 3);
  assert.deepEqual(calls, [
    { origin: 'internal', enableFollowUp: false },
    { origin: 'internal', enableFollowUp: false },
    { origin: 'internal', enableFollowUp: false },
  ]);
});

test('worker mode prevents the automatic enqueue trigger from invoking the HTTP processor', async () => {
  const previousMode = process.env.DISBURSE_PROCESSOR_MODE;
  try {
    process.env.DISBURSE_PROCESSOR_MODE = 'worker';
    let scheduled = false;
    let posts = 0;
    triggerInternalJobProcessing({
      schedule: () => { scheduled = true; },
      post: async () => { posts += 1; },
    });
    assert.equal(scheduled, false);
    assert.equal(posts, 0);

    delete process.env.DISBURSE_PROCESSOR_MODE;
    let scheduledCallback: (() => Promise<void>) | undefined;
    triggerInternalJobProcessing({
      schedule: (callback) => { scheduledCallback = callback; },
      post: async () => { posts += 1; },
    });
    assert.ok(scheduledCallback);
    await scheduledCallback();
    assert.equal(posts, 1);
  } finally {
    if (previousMode === undefined) delete process.env.DISBURSE_PROCESSOR_MODE;
    else process.env.DISBURSE_PROCESSOR_MODE = previousMode;
  }
});

test('worker shutdown stops future polling after the current processor invocation', async () => {
  let calls = 0;
  let worker: PipelineWorker;
  worker = quietWorker({
    processor: async () => {
      calls += 1;
      return result('queue_empty');
    },
    sleep: async () => worker.requestShutdown(),
  });

  await worker.run();

  assert.equal(calls, 1);
});

test('worker completes an active processor invocation before shutting down', async () => {
  let resolveProcessor: (() => void) | undefined;
  let processorStarted: (() => void) | undefined;
  const processorStartedPromise = new Promise<void>((resolve) => {
    processorStarted = resolve;
  });
  const processorCompletion = new Promise<void>((resolve) => {
    resolveProcessor = resolve;
  });
  let calls = 0;
  const worker = quietWorker({
    processor: async () => {
      calls += 1;
      processorStarted!();
      await processorCompletion;
      return result('queue_empty');
    },
  });

  const run = worker.run();
  await processorStartedPromise;
  worker.requestShutdown();
  assert.equal(calls, 1);
  resolveProcessor!();
  await run;
  assert.equal(calls, 1);
});

test('a fatal processor result is contained and does not terminate the worker loop', async () => {
  const results = [result('fatal_error'), result('queue_empty')];
  let calls = 0;
  let sleeps = 0;
  let worker: PipelineWorker;
  worker = quietWorker({
    processor: async () => {
      calls += 1;
      return results.shift()!;
    },
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 2) worker.requestShutdown();
    },
  });

  await worker.run();

  assert.equal(calls, 2);
});

test('an unexpected processor exception backs off and the worker continues', async () => {
  let calls = 0;
  const sleeps: number[] = [];
  let worker: PipelineWorker;
  worker = quietWorker({
    processor: async () => {
      calls += 1;
      if (calls === 1) throw new Error('unexpected processor failure');
      return result('queue_empty');
    },
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      if (sleeps.length === 2) worker.requestShutdown();
    },
  });

  await worker.run();

  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [5_000, 2_000]);
});
