import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { and, eq, sql } from 'drizzle-orm';

import { db } from '@/lib/db/drizzle';
import {
  jobEffectCheckpoints,
  JobEffectCheckpointStatus,
  JobRecoveryMode,
  JobType,
  type Job,
} from '@/lib/db/schema';
import {
  parseJobEffectCheckpointResult,
  type JobEffectCheckpointResult,
} from '@/lib/disburse/job-effect-checkpoint-schema';
import { withAuthorizedJobTransaction } from '@/lib/disburse/job-execution-authorization';
import {
  maybeInjectOperationalFault,
  OperationalFaultInjectionError,
  type FaultInjectionProvider,
} from '@/lib/disburse/fault-injection';
import { getOperationalCorrelation } from '@/lib/disburse/operational-context';
import { emitOperationalEvent } from '@/lib/disburse/operational-events';

export const PRIMARY_JOB_EFFECT_KEY = 'primary_external_effect_v1';
type ExternalEffectBoundary = {
  beforeSend: () => Promise<void>;
  afterSend: () => Promise<void>;
  afterSuccess: () => Promise<void>;
};

const externalEffectBoundary = new AsyncLocalStorage<ExternalEffectBoundary>();
const MAX_OPERATIONAL_FAULT_CAUSE_DEPTH = 16;

export function getFaultInjectionProviderForJobType(
  jobType: JobType
): FaultInjectionProvider | null {
  if (jobType === JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL) return 's3';
  if (
    jobType === JobType.RENDER_CLIP_CANDIDATE ||
    jobType === JobType.FORMAT_RENDERED_CLIP_SHORT_FORM
  ) return 'render';
  if (jobType === JobType.DETECT_CLIP_FACECAM) return 'facecam';
  return null;
}

export function getOperationalFaultInjectionError(error: unknown) {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < MAX_OPERATIONAL_FAULT_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error) || seen.has(current)) return null;
    if (current instanceof OperationalFaultInjectionError) return current;
    seen.add(current);
    try {
      current = current.cause;
    } catch {
      return null;
    }
  }
  return null;
}

function emitInjectedFaultEvent(job: Job, error: unknown) {
  const fault = getOperationalFaultInjectionError(error);
  if (!fault) return;
  try {
    emitOperationalEvent('pipeline.provider_boundary', {
      invocationId: getOperationalCorrelation().invocationId,
      jobId: job.id,
      jobType: job.type,
      provider: fault.provider,
      boundary: fault.point,
      failureClass: 'transient',
      failureCode: fault.code,
    });
  } catch {
    // Operational events must never suppress the injected fault.
  }
}

export async function withExternalEffectBoundary<T>(
  begin: () => Promise<void>,
  effect: () => Promise<T>,
  provider: FaultInjectionProvider | null = null
) {
  return await externalEffectBoundary.run({
    beforeSend: async () => {
      if (provider) maybeInjectOperationalFault(provider, 'before_send');
      await begin();
    },
    afterSend: async () => {
      if (provider) maybeInjectOperationalFault(provider, 'after_send_before_response');
    },
    afterSuccess: async () => {
      if (provider) {
        maybeInjectOperationalFault(provider, 'after_provider_success_before_persistence');
      }
    },
  }, effect);
}

export async function beginExternalEffectBoundary() {
  await externalEffectBoundary.getStore()?.beforeSend();
}

export async function afterExternalEffectSendBoundary() {
  await externalEffectBoundary.getStore()?.afterSend();
}

export async function afterExternalEffectSuccessBoundary() {
  await externalEffectBoundary.getStore()?.afterSuccess();
}

export class ExternalEffectNotStartedError extends Error {
  constructor(public readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : 'External effect did not start.');
    this.name = 'ExternalEffectNotStartedError';
  }
}

export class AmbiguousExternalEffectError extends Error {
  constructor(public readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : 'External effect outcome is ambiguous.');
    this.name = 'AmbiguousExternalEffectError';
  }
}

export async function getCompletedCheckpointForJob(jobId: number, type: JobType) {
  const checkpoint = await db.query.jobEffectCheckpoints.findFirst({
    where: and(
      eq(jobEffectCheckpoints.jobId, jobId),
      eq(jobEffectCheckpoints.effectKey, PRIMARY_JOB_EFFECT_KEY),
      eq(jobEffectCheckpoints.jobType, type),
      eq(jobEffectCheckpoints.status, JobEffectCheckpointStatus.COMPLETED)
    ),
  });
  if (!checkpoint?.result) return null;
  return parseJobEffectCheckpointResult(type, checkpoint.result);
}

export async function getJobEffectState(jobId: number) {
  return await db.query.jobEffectCheckpoints.findFirst({
    where: and(
      eq(jobEffectCheckpoints.jobId, jobId),
      eq(jobEffectCheckpoints.effectKey, PRIMARY_JOB_EFFECT_KEY)
    ),
  });
}

export async function runCheckpointedExternalEffect<T extends JobEffectCheckpointResult>(
  job: Job,
  buildResult: (
    beginExternalEffect: () => Promise<void>
  ) => Promise<T>,
  faultProvider: FaultInjectionProvider | null = getFaultInjectionProviderForJobType(
    job.type as JobType
  )
): Promise<{ result: T; resumed: boolean }> {
  if (job.type === JobType.PUBLISH_RENDERED_CLIP) {
    throw new Error('Publishing does not support recoverable checkpoints.');
  }

  if (job.recoveryMode === JobRecoveryMode.RESUME) {
    if (!job.parentJobId) throw new Error('Resume job is missing its parent checkpoint.');
    const result = await getCompletedCheckpointForJob(job.parentJobId, job.type as JobType);
    if (!result) throw new Error('A completed typed checkpoint is required to resume.');
    return { result: result as T, resumed: true };
  }

  if (!job.leaseToken) throw new Error('Checkpointed job is missing its lease token.');
  const authority = { jobId: job.id, leaseToken: job.leaseToken };
  const completed = await withAuthorizedJobTransaction(authority, async (tx) => {
    const [existing] = await tx.select().from(jobEffectCheckpoints).where(and(
      eq(jobEffectCheckpoints.jobId, job.id),
      eq(jobEffectCheckpoints.effectKey, PRIMARY_JOB_EFFECT_KEY)
    )).for('update').limit(1);
    if (!existing) {
      await tx.insert(jobEffectCheckpoints).values({
        jobId: job.id,
        effectKey: PRIMARY_JOB_EFFECT_KEY,
        jobType: job.type,
        status: JobEffectCheckpointStatus.PREPARED,
      });
      return null;
    }
    if (existing.jobType !== job.type) {
      throw new AmbiguousExternalEffectError(new Error('External-effect checkpoint job type is invalid.'));
    }
    if (existing.status === JobEffectCheckpointStatus.COMPLETED) {
      const parsed = existing.result
        ? parseJobEffectCheckpointResult(job.type as JobType, existing.result)
        : null;
      if (!parsed) {
        throw new AmbiguousExternalEffectError(new Error('Completed external-effect checkpoint is invalid.'));
      }
      return parsed;
    }
    if (existing.status === JobEffectCheckpointStatus.EXTERNAL_EFFECT_STARTED) {
      throw new AmbiguousExternalEffectError(new Error('External effect was already started by another invocation.'));
    }
    if (
      existing.status !== JobEffectCheckpointStatus.PREPARED ||
      existing.result !== null ||
      existing.completedAt !== null ||
      existing.externalEffectStartedAt !== null
    ) {
      throw new AmbiguousExternalEffectError(new Error('External-effect checkpoint state is invalid.'));
    }
    return null;
  });
  if (completed) return { result: completed as T, resumed: true };

  let began = false;
  let initialBoundary: Promise<void> | null = null;
  const authorizeInitialBoundary = async () => {
    await withAuthorizedJobTransaction(authority, async (tx) => {
      const [updated] = await tx.update(jobEffectCheckpoints).set({
        status: JobEffectCheckpointStatus.EXTERNAL_EFFECT_STARTED,
        externalEffectStartedAt: sql`clock_timestamp()`,
        updatedAt: new Date(),
      }).where(and(
        eq(jobEffectCheckpoints.jobId, job.id),
        eq(jobEffectCheckpoints.effectKey, PRIMARY_JOB_EFFECT_KEY),
        eq(jobEffectCheckpoints.jobType, job.type),
        eq(jobEffectCheckpoints.status, JobEffectCheckpointStatus.PREPARED),
        sql<boolean>`${jobEffectCheckpoints.result} is null`,
        sql<boolean>`${jobEffectCheckpoints.externalEffectStartedAt} is null`,
        sql<boolean>`${jobEffectCheckpoints.completedAt} is null`
      )).returning({ id: jobEffectCheckpoints.id });
      if (!updated) {
        throw new AmbiguousExternalEffectError(new Error('External effect was not atomically authorized.'));
      }
    });
    began = true;
  };
  const revalidateStartedBoundary = async () => {
    await withAuthorizedJobTransaction(authority, async (tx) => {
      const [checkpoint] = await tx.select().from(jobEffectCheckpoints).where(and(
        eq(jobEffectCheckpoints.jobId, job.id),
        eq(jobEffectCheckpoints.effectKey, PRIMARY_JOB_EFFECT_KEY)
      )).for('update').limit(1);
      if (
        !checkpoint ||
        checkpoint.jobType !== job.type ||
        checkpoint.status !== JobEffectCheckpointStatus.EXTERNAL_EFFECT_STARTED ||
        checkpoint.result !== null ||
        checkpoint.externalEffectStartedAt === null ||
        checkpoint.completedAt !== null
      ) {
        throw new AmbiguousExternalEffectError(new Error('External-effect checkpoint drifted after the effect started.'));
      }
    });
  };
  const beginExternalEffect = async () => {
    const isInitialBoundary = initialBoundary === null;
    if (isInitialBoundary) {
      initialBoundary = authorizeInitialBoundary();
    }
    await initialBoundary;
    if (!isInitialBoundary) await revalidateStartedBoundary();
  };

  try {
    const result = await buildResult(beginExternalEffect);
    const parsed = parseJobEffectCheckpointResult(job.type as JobType, result);
    if (!parsed) throw new Error('External-effect checkpoint result is invalid.');
    await withAuthorizedJobTransaction(authority, async (tx) => {
      const expectedStatus = began
        ? JobEffectCheckpointStatus.EXTERNAL_EFFECT_STARTED
        : JobEffectCheckpointStatus.PREPARED;
      const [updated] = await tx.update(jobEffectCheckpoints).set({
        status: JobEffectCheckpointStatus.COMPLETED,
        result: parsed as unknown as Record<string, unknown>,
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(jobEffectCheckpoints.jobId, job.id),
        eq(jobEffectCheckpoints.effectKey, PRIMARY_JOB_EFFECT_KEY),
        eq(jobEffectCheckpoints.jobType, job.type),
        eq(jobEffectCheckpoints.status, expectedStatus),
        sql<boolean>`${jobEffectCheckpoints.result} is null`,
        began
          ? sql<boolean>`${jobEffectCheckpoints.externalEffectStartedAt} is not null`
          : sql<boolean>`${jobEffectCheckpoints.externalEffectStartedAt} is null`,
        sql<boolean>`${jobEffectCheckpoints.completedAt} is null`
      )).returning({ id: jobEffectCheckpoints.id });
      if (!updated) {
        throw new AmbiguousExternalEffectError(new Error('External-effect checkpoint completion was not authorized.'));
      }
    });
    if (faultProvider) {
      maybeInjectOperationalFault(
        faultProvider,
        'after_checkpoint_persistence_before_finalization'
      );
    }
    return { result: parsed as T, resumed: false };
  } catch (error) {
    emitInjectedFaultEvent(job, error);
    if (error instanceof AmbiguousExternalEffectError) throw error;
    if (!began) throw new ExternalEffectNotStartedError(error);
    throw new AmbiguousExternalEffectError(error);
  }
}
