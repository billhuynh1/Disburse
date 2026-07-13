import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

import type { ClaimedPipelineJob } from './job-service.ts';
import type { PipelineProcessingRuntime } from './pipeline-service.ts';

register('../test/typescript-path-loader.mjs', import.meta.url);

process.env.POSTGRES_URL ??= 'postgres://test:test@127.0.0.1:1/test';
process.env.INTERNAL_PROCESSING_SECRET ??= 'test';

type AuthorityReason =
  | 'cancellation_requested'
  | 'generation_superseded'
  | 'job_not_processing'
  | 'lease_mismatch';

type Harness = {
  effects: string[];
  runtime: PipelineProcessingRuntime;
  setAuthority(authorized: boolean, reason?: AuthorityReason): void;
  runHeartbeat(): Promise<void>;
};

function claimedJob(type: string, payload: Record<string, unknown>) {
  return {
    id: 101,
    type,
    status: 'processing',
    idempotencyKey: `test:${type}`,
    payload,
    attemptCount: 1,
    maxAttempts: 3,
    availableAt: new Date(),
    startedAt: new Date(),
    heartbeatAt: new Date(),
    leaseToken: 'token-a',
    leaseExpiresAt: new Date(Date.now() + 60_000),
    completedAt: null,
    cancellationReason: null,
    cancellationRequestedAt: null,
    failureReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as ClaimedPipelineJob;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function createHarness(): Promise<Harness> {
  const {
    productionPipelineProcessingRuntime,
  } = await import('./pipeline-service.ts');
  const { JobExecutionUnauthorizedError } =
    await import('./job-execution-authorization.ts');
  const effects: string[] = [];
  let authorized = true;
  let unauthorizedReason: AuthorityReason = 'lease_mismatch';
  let heartbeatCallback: (() => void) | null = null;

  const assertAuthorized: PipelineProcessingRuntime['authorization']['assert'] =
    async () => {
      if (!authorized) {
        throw new JobExecutionUnauthorizedError(unauthorizedReason);
      }
      return {} as Awaited<ReturnType<PipelineProcessingRuntime['authorization']['assert']>>;
    };

  const runtime: PipelineProcessingRuntime = {
    ...productionPipelineProcessingRuntime,
    lease: {
      heartbeat: async () => true,
    },
    authorization: {
      assert: assertAuthorized,
      validateFreshness: async () => null,
      withTransaction: async (authority, callback) => {
        await assertAuthorized(authority);
        return callback({} as never, {} as never);
      },
    },
    terminal: {
      cancelStale: async () => {
        effects.push('job:cancelled');
      },
      complete: async (authority, callback) => {
        await assertAuthorized(authority);
        const result = await callback({} as never, {} as never);
        effects.push('job:completed');
        return result;
      },
      fail: async (authority, failureReason, callback) => {
        await assertAuthorized(authority);
        const result = await callback({} as never, {} as never);
        effects.push(`job:failed:${failureReason}`);
        return result;
      },
      markCompleted: async () => {
        await assertAuthorized({ jobId: 101, leaseToken: 'token-a' });
        effects.push('job:completed');
      },
      markFailed: async () => {
        if (!authorized) return false;
        effects.push('job:failed');
        return true;
      },
    },
    mutations: {
      ...productionPipelineProcessingRuntime.mutations,
      wakeShortFormJobs: async () => {
        effects.push('jobs:woken');
      },
      reconcileShortFormPack: async () => {
        effects.push('pack:reconciled');
        return {} as never;
      },
      applyFacecamResult: async () => {
        effects.push('facecam:persisted');
        return {} as never;
      },
      enqueueFormatJobs: async () => {
        effects.push('render:enqueued');
        return 1;
      },
      enqueueFormatFallback: async () => {
        effects.push('render:fallback-enqueued');
        return {} as never;
      },
      enqueueShortFormPack: async () => {
        effects.push('generation:enqueued');
        return {} as never;
      },
      markContentPackFailed: async () => {
        effects.push('pack:failed');
        return {} as never;
      },
      markRenderedClipFailed: async () => {
        effects.push('render:failed');
        return {} as never;
      },
      markCandidateFacecamFailed: async () => {
        effects.push('facecam:failed');
        return {} as never;
      },
      markPublicationFailed: async () => {
        effects.push('publication:failed');
        return {} as never;
      },
      markTranscriptFailed: async () => {
        effects.push('transcript:failed');
        return {} as never;
      },
    },
    downstream: {
      trigger: () => {
        effects.push('downstream:triggered');
      },
    },
    timer: {
      startHeartbeat: (callback) => {
        heartbeatCallback = callback;
        return callback;
      },
      stopHeartbeat: () => undefined,
    },
  };

  return {
    effects,
    runtime,
    setAuthority(nextAuthorized, reason = 'lease_mismatch') {
      authorized = nextAuthorized;
      unauthorizedReason = reason;
    },
    async runHeartbeat() {
      assert.ok(heartbeatCallback);
      heartbeatCallback();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

test('claimed-job orchestration suppresses stale worker effects', async (t) => {
  const { JobType } = await import('../db/schema.ts');
  const { processClaimedJob } = await import('./pipeline-service.ts');
  const sourcePayload = { sourceAssetId: 1, userId: 1 };

  await t.test('authority lost before dispatch does not start the stage', async () => {
    const harness = await createHarness();
    harness.setAuthority(false);
    let stageStarted = false;
    harness.runtime.processors.transcribe = (async () => {
      stageStarted = true;
      return {} as never;
    }) as PipelineProcessingRuntime['processors']['transcribe'];

    const result = await processClaimedJob(
      claimedJob(JobType.TRANSCRIBE_SOURCE_ASSET, sourcePayload),
      harness.runtime
    );

    assert.equal(result.status, 'lease_lost');
    assert.equal(stageStarted, false);
    assert.deepEqual(harness.effects, []);
  });

  await t.test('cancellation during transcription suppresses persistence and finalization', async () => {
    const harness = await createHarness();
    const external = deferred<void>();
    harness.runtime.processors.transcribe = (async (_sourceAssetId, authority) => {
      harness.effects.push('external:started');
      await external.promise;
      harness.effects.push('external:finished');
      await harness.runtime.authorization.assert(authority);
      harness.effects.push('transcript:persisted', 'notification:created');
      return { id: 11 } as never;
    }) as PipelineProcessingRuntime['processors']['transcribe'];
    const processing = processClaimedJob(
      claimedJob(JobType.TRANSCRIBE_SOURCE_ASSET, sourcePayload),
      harness.runtime
    );
    await Promise.resolve();
    harness.setAuthority(false, 'cancellation_requested');
    external.resolve();

    const result = await processing;
    assert.equal(result.status, 'lease_lost');
    assert.deepEqual(harness.effects, ['external:started', 'external:finished']);
  });

  await t.test('a replaced lease token fences the old render worker', async () => {
    const harness = await createHarness();
    const external = deferred<void>();
    harness.runtime.processors.renderClip = (async () => {
      await external.promise;
      harness.effects.push('storage:rendered');
      return { id: 44 } as never;
    }) as PipelineProcessingRuntime['processors']['renderClip'];
    const processing = processClaimedJob(
      claimedJob(JobType.RENDER_CLIP_CANDIDATE, {
        ...sourcePayload,
        contentPackId: 2,
        clipCandidateId: 3,
        generationRunId: 'run-a',
      }),
      harness.runtime
    );
    await Promise.resolve();
    harness.setAuthority(false, 'lease_mismatch');
    external.resolve();

    const result = await processing;
    assert.equal(result.status, 'lease_lost');
    assert.deepEqual(harness.effects, ['storage:rendered']);
    harness.setAuthority(true);
    await harness.runtime.authorization.assert({ jobId: 101, leaseToken: 'token-b' });
  });

  await t.test('a superseded generation cannot persist LLM output', async () => {
    const harness = await createHarness();
    harness.runtime.processors.waitForTranscript = (async () => ({ id: 8 })) as never;
    harness.runtime.processors.generateShortForm = (async (_packId, _runId, authority) => {
      harness.effects.push('llm:finished');
      harness.setAuthority(false, 'generation_superseded');
      await harness.runtime.authorization.assert(authority);
      harness.effects.push('candidates:persisted');
      return {} as never;
    }) as PipelineProcessingRuntime['processors']['generateShortForm'];

    const result = await processClaimedJob(
      claimedJob(JobType.GENERATE_SHORT_FORM_PACK, {
        ...sourcePayload,
        contentPackId: 2,
        generationRunId: 'run-a',
      }),
      harness.runtime
    );

    assert.equal(result.status, 'lease_lost');
    assert.deepEqual(harness.effects, ['llm:finished']);
  });

  for (const stage of ['facecam', 'format'] as const) {
    await t.test(`${stage} output finishing after cancellation remains orphaned`, async () => {
      const harness = await createHarness();
      const external = deferred<void>();
      const payload = {
        ...sourcePayload,
        contentPackId: 2,
        clipCandidateId: 3,
        generationRunId: 'run-a',
        startTimeMs: 0,
        endTimeMs: 1_000,
        detectorVersion: 'v1',
        detectionRunId: 4,
      };
      const type = stage === 'facecam'
        ? JobType.DETECT_CLIP_FACECAM
        : JobType.FORMAT_RENDERED_CLIP_SHORT_FORM;
      if (stage === 'facecam') {
        harness.runtime.processors.detectCandidateFacecam = (async () => {
          await external.promise;
          harness.effects.push('external:facecam-output');
          return { status: 'not_detected', detectionCount: 0 } as never;
        }) as PipelineProcessingRuntime['processors']['detectCandidateFacecam'];
      } else {
        harness.runtime.processors.formatClip = (async () => {
          await external.promise;
          harness.effects.push('external:render-output');
          return { id: 5 } as never;
        }) as PipelineProcessingRuntime['processors']['formatClip'];
      }
      const processing = processClaimedJob(claimedJob(type, payload), harness.runtime);
      await Promise.resolve();
      harness.setAuthority(false, 'cancellation_requested');
      external.resolve();

      const result = await processing;
      assert.equal(result.status, 'lease_lost');
      assert.equal(harness.effects.length, 1);
      assert.ok(harness.effects[0].startsWith('external:'));
    });
  }

  await t.test('authority lost during domain failure suppresses failure mutations', async () => {
    const harness = await createHarness();
    harness.runtime.processors.formatClip = (async () => {
      harness.setAuthority(false, 'cancellation_requested');
      throw new Error('renderer failed');
    }) as PipelineProcessingRuntime['processors']['formatClip'];

    const result = await processClaimedJob(
      claimedJob(JobType.FORMAT_RENDERED_CLIP_SHORT_FORM, {
        ...sourcePayload,
        contentPackId: 2,
        clipCandidateId: 3,
        generationRunId: 'run-a',
      }),
      harness.runtime
    );

    assert.equal(result.status, 'lease_lost');
    assert.deepEqual(harness.effects, []);
  });

  await t.test('publishing retains terminal fencing after provider work', async () => {
    const harness = await createHarness();
    const external = deferred<void>();
    harness.runtime.processors.publishClip = (async () => {
      await external.promise;
      harness.effects.push('provider:published');
      return {
        publication: { id: 7 },
        result: { platformPostId: 'post-1', platformUrl: 'https://example.test/post-1' },
      } as never;
    }) as PipelineProcessingRuntime['processors']['publishClip'];
    const processing = processClaimedJob(
      claimedJob(JobType.PUBLISH_RENDERED_CLIP, {
        clipPublicationId: 7,
        renderedClipId: 8,
        linkedAccountId: 9,
        userId: 1,
        platform: 'youtube',
      }),
      harness.runtime
    );
    await Promise.resolve();
    harness.setAuthority(false, 'lease_mismatch');
    external.resolve();

    const result = await processing;
    assert.equal(result.status, 'lease_lost');
    assert.deepEqual(harness.effects, ['provider:published']);
  });

  await t.test('durable downstream identity survives a crash after completion', async () => {
    const harness = await createHarness();
    let stageRuns = 0;
    let downstreamRows = 0;
    harness.runtime.processors.transcribe = (async () => {
      stageRuns += 1;
      return { id: 11 } as never;
    }) as PipelineProcessingRuntime['processors']['transcribe'];
    harness.runtime.mutations.wakeShortFormJobs = async () => {
      downstreamRows = Math.min(1, downstreamRows + 1);
      harness.effects.push('result:persisted');
    };
    harness.runtime.terminal.complete = async (authority, callback) => {
      await harness.runtime.authorization.assert(authority);
      const result = await callback({} as never, {} as never);
      harness.effects.push('job:completed');
      harness.setAuthority(false, 'job_not_processing');
      return result;
    };
    harness.runtime.downstream.trigger = () => {
      throw new Error('worker crashed before downstream processing');
    };
    const job = claimedJob(JobType.TRANSCRIBE_SOURCE_ASSET, sourcePayload);

    const first = await processClaimedJob(job, harness.runtime);
    const replay = await processClaimedJob(job, harness.runtime);

    assert.equal(first.status, 'lease_lost');
    assert.equal(replay.status, 'lease_lost');
    assert.equal(stageRuns, 1);
    assert.equal(downstreamRows, 1);
    assert.deepEqual(harness.effects, ['result:persisted', 'job:completed']);
    assert.equal(harness.effects.includes('result:persisted'), true);
  });

  for (const heartbeatOutcome of ['false', 'throws'] as const) {
    await t.test(`heartbeat ${heartbeatOutcome} prevents terminal effects`, async () => {
      const harness = await createHarness();
      const external = deferred<void>();
      const infoEvents: unknown[][] = [];
      const originalInfo = console.info;
      console.info = (...args: unknown[]) => {
        infoEvents.push(args);
      };
      try {
        harness.runtime.lease.heartbeat = heartbeatOutcome === 'false'
          ? async () => false
          : async () => { throw new Error('heartbeat unavailable'); };
        harness.runtime.processors.transcribe = (async () => {
          await external.promise;
          return { id: 11 } as never;
        }) as PipelineProcessingRuntime['processors']['transcribe'];
        const processing = processClaimedJob(
          claimedJob(JobType.TRANSCRIBE_SOURCE_ASSET, sourcePayload),
          harness.runtime
        );
        await Promise.resolve();
        await harness.runHeartbeat();
        external.resolve();

        const result = await processing;
        assert.equal(result.status, 'lease_lost');
        assert.deepEqual(harness.effects, []);
        assert.equal(
          infoEvents.some((event) =>
            JSON.stringify(event).includes(
              heartbeatOutcome === 'false'
                ? 'heartbeat_renewal_rejected'
                : 'heartbeat_renewal_failed'
            )
          ),
          true
        );
      } finally {
        console.info = originalInfo;
      }
    });
  }
});
