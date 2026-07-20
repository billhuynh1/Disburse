import 'server-only';

import { eq, sql } from 'drizzle-orm';

import { db } from '@/lib/db/drizzle';
import { operationalInvocations } from '@/lib/db/schema';
import {
  classifyOperationalFailure,
  emitOperationalEvent,
  type OperationalFailureClass,
} from '@/lib/disburse/operational-events';

export type OperationalInvocationOrigin = 'internal' | 'cron';

export async function startOperationalInvocation(params: {
  invocationId: string;
  origin: OperationalInvocationOrigin;
}) {
  emitOperationalEvent('pipeline.invocation_started', params);
  await db.insert(operationalInvocations).values({
    invocationId: params.invocationId,
    origin: params.origin,
    status: 'running',
  });
}

export async function completeOperationalInvocation(params: {
  invocationId: string;
  origin: OperationalInvocationOrigin;
  stopReason: string;
  durationMs: number;
  processedJobs: number;
  recoveredJobs: number;
  reconciledProjects: number;
  reconciliationCycle: number | null;
  followUpTriggered: boolean;
  failureClass?: OperationalFailureClass;
  failureCode?: string;
}) {
  const failed = params.stopReason === 'fatal_error';
  await db.update(operationalInvocations).set({
    status: failed ? 'failed' : 'completed',
    stopReason: params.stopReason,
    durationMs: params.durationMs,
    processedJobs: params.processedJobs,
    recoveredJobs: params.recoveredJobs,
    reconciledProjects: params.reconciledProjects,
    reconciliationCycle: params.reconciliationCycle,
    followUpTriggered: params.followUpTriggered,
    failureClass: params.failureClass ?? null,
    failureCode: params.failureCode ?? null,
    completedAt: sql`clock_timestamp()`,
  }).where(eq(operationalInvocations.invocationId, params.invocationId));
  emitOperationalEvent(
    failed ? 'pipeline.invocation_failed' : 'pipeline.invocation_completed',
    params
  );
}

export async function failOperationalInvocation(params: {
  invocationId: string;
  origin: OperationalInvocationOrigin;
  durationMs: number;
  error: unknown;
}) {
  const failure = classifyOperationalFailure(params.error);
  await completeOperationalInvocation({
    ...params,
    ...failure,
    stopReason: 'fatal_error',
    processedJobs: 0,
    recoveredJobs: 0,
    reconciledProjects: 0,
    reconciliationCycle: null,
    followUpTriggered: false,
  });
}
