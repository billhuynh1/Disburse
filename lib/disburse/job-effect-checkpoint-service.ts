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

export const PRIMARY_JOB_EFFECT_KEY = 'primary_external_effect_v1';
const externalEffectBoundary = new AsyncLocalStorage<() => Promise<void>>();

export async function withExternalEffectBoundary<T>(
  begin: () => Promise<void>,
  effect: () => Promise<T>
) {
  return await externalEffectBoundary.run(begin, effect);
}

export async function beginExternalEffectBoundary() {
  const begin = externalEffectBoundary.getStore();
  if (begin) await begin();
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
  ) => Promise<T>
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

  const now = new Date();
  await db.insert(jobEffectCheckpoints).values({
    jobId: job.id,
    effectKey: PRIMARY_JOB_EFFECT_KEY,
    jobType: job.type,
    status: JobEffectCheckpointStatus.PREPARED,
  }).onConflictDoNothing({
    target: [jobEffectCheckpoints.jobId, jobEffectCheckpoints.effectKey],
  });

  let began = false;
  const beginExternalEffect = async () => {
    if (began) return;
    began = true;
    const [updated] = await db.update(jobEffectCheckpoints).set({
      status: JobEffectCheckpointStatus.EXTERNAL_EFFECT_STARTED,
      externalEffectStartedAt: sql`coalesce(${jobEffectCheckpoints.externalEffectStartedAt}, clock_timestamp())`,
      updatedAt: new Date(),
    }).where(and(
      eq(jobEffectCheckpoints.jobId, job.id),
      eq(jobEffectCheckpoints.effectKey, PRIMARY_JOB_EFFECT_KEY),
      eq(jobEffectCheckpoints.status, JobEffectCheckpointStatus.PREPARED)
    )).returning({ id: jobEffectCheckpoints.id });
    if (!updated) {
      const state = await getJobEffectState(job.id);
      if (state?.status !== JobEffectCheckpointStatus.EXTERNAL_EFFECT_STARTED) {
        throw new Error('External-effect checkpoint could not be started.');
      }
    }
  };

  try {
    const result = await buildResult(beginExternalEffect);
    const parsed = parseJobEffectCheckpointResult(job.type as JobType, result);
    if (!parsed) throw new Error('External-effect checkpoint result is invalid.');
    await db.update(jobEffectCheckpoints).set({
      status: JobEffectCheckpointStatus.COMPLETED,
      result: parsed as unknown as Record<string, unknown>,
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(jobEffectCheckpoints.jobId, job.id),
      eq(jobEffectCheckpoints.effectKey, PRIMARY_JOB_EFFECT_KEY)
    ));
    return { result: parsed as T, resumed: false };
  } catch (error) {
    if (!began) {
      await db.delete(jobEffectCheckpoints).where(and(
        eq(jobEffectCheckpoints.jobId, job.id),
        eq(jobEffectCheckpoints.effectKey, PRIMARY_JOB_EFFECT_KEY),
        eq(jobEffectCheckpoints.status, JobEffectCheckpointStatus.PREPARED)
      ));
      throw new ExternalEffectNotStartedError(error);
    }
    throw new AmbiguousExternalEffectError(error);
  }
}
