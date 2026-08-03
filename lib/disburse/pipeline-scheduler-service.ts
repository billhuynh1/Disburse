import 'server-only';

import { randomUUID } from 'node:crypto';

import { and, eq, isNull, sql } from 'drizzle-orm';

import { db } from '@/lib/db/drizzle';
import { pipelineSchedulerState } from '@/lib/db/schema';

export const PIPELINE_SCHEDULER_STATE_ID = 1;
export const DEFAULT_PROCESSOR_LEASE_MS = 90_000;
export const PROCESSOR_HEARTBEAT_INTERVAL_MS = 30_000;

export type PipelineProcessorOwnership = {
  ownerToken: string;
  reconciliationCursor: number | null;
  reconciliationCycle: number;
};

async function ensureSchedulerState(
  executor: Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db
) {
  await executor.insert(pipelineSchedulerState).values({
    id: PIPELINE_SCHEDULER_STATE_ID,
  }).onConflictDoNothing({ target: pipelineSchedulerState.id });
}

export async function acquirePipelineProcessor(params: {
  ownerToken?: string;
  leaseMs?: number;
} = {}): Promise<PipelineProcessorOwnership | null> {
  const ownerToken = params.ownerToken ?? randomUUID();
  const leaseMs = params.leaseMs ?? DEFAULT_PROCESSOR_LEASE_MS;

  return await db.transaction(async (tx) => {
    await ensureSchedulerState(tx);
    const [state] = await tx.update(pipelineSchedulerState).set({
      ownerToken,
      heartbeatAt: sql`clock_timestamp()`,
      leaseExpiresAt: sql`clock_timestamp() + (${leaseMs} * interval '1 millisecond')`,
      updatedAt: sql`clock_timestamp()`,
    }).where(and(
      eq(pipelineSchedulerState.id, PIPELINE_SCHEDULER_STATE_ID),
      sql<boolean>`(
        ${pipelineSchedulerState.ownerToken} is null
        or ${pipelineSchedulerState.leaseExpiresAt} is null
        or ${pipelineSchedulerState.leaseExpiresAt} <= clock_timestamp()
      )`
  )).returning({
    reconciliationCursor: pipelineSchedulerState.reconciliationCursor,
    reconciliationCycle: pipelineSchedulerState.reconciliationCycle,
    reconciliationProgressAt: pipelineSchedulerState.reconciliationProgressAt,
    reconciliationProgressCount: pipelineSchedulerState.reconciliationProgressCount,
  });

    return state ? { ownerToken, ...state } : null;
  });
}

export async function heartbeatPipelineProcessor(
  ownerToken: string,
  leaseMs = DEFAULT_PROCESSOR_LEASE_MS
) {
  return await db.transaction(async (tx) => {
    const [state] = await tx.select({
      ownerToken: pipelineSchedulerState.ownerToken,
    }).from(pipelineSchedulerState)
      .where(eq(pipelineSchedulerState.id, PIPELINE_SCHEDULER_STATE_ID))
      .for('update')
      .limit(1);
    if (state?.ownerToken !== ownerToken) return false;
    const [freshLease] = await tx.select({
      leaseIsValid:
        sql<boolean>`${pipelineSchedulerState.leaseExpiresAt} > clock_timestamp()`,
    }).from(pipelineSchedulerState)
      .where(eq(pipelineSchedulerState.id, PIPELINE_SCHEDULER_STATE_ID))
      .limit(1);
    if (!freshLease?.leaseIsValid) return false;

    await tx.update(pipelineSchedulerState).set({
      heartbeatAt: sql`clock_timestamp()`,
      leaseExpiresAt: sql`clock_timestamp() + (${leaseMs} * interval '1 millisecond')`,
      updatedAt: sql`clock_timestamp()`,
    }).where(eq(pipelineSchedulerState.id, PIPELINE_SCHEDULER_STATE_ID));
    return true;
  });
}

export async function hasPipelineProcessorOwnership(ownerToken: string) {
  const [state] = await db.select({ id: pipelineSchedulerState.id })
    .from(pipelineSchedulerState)
    .where(and(
      eq(pipelineSchedulerState.id, PIPELINE_SCHEDULER_STATE_ID),
      eq(pipelineSchedulerState.ownerToken, ownerToken),
      sql<boolean>`${pipelineSchedulerState.leaseExpiresAt} > clock_timestamp()`
    )).limit(1);
  return Boolean(state);
}

export async function releasePipelineProcessor(ownerToken: string) {
  const [state] = await db.update(pipelineSchedulerState).set({
    ownerToken: null,
    leaseExpiresAt: null,
    heartbeatAt: sql`clock_timestamp()`,
    updatedAt: sql`clock_timestamp()`,
  }).where(and(
    eq(pipelineSchedulerState.id, PIPELINE_SCHEDULER_STATE_ID),
    eq(pipelineSchedulerState.ownerToken, ownerToken)
  )).returning({ id: pipelineSchedulerState.id });
  return Boolean(state);
}

export async function advancePipelineReconciliationCursor(params: {
  ownerToken: string;
  expectedCursor: number | null;
  nextCursor: number | null;
  wrap: boolean;
}) {
  const expectedCursor = params.expectedCursor === null
    ? isNull(pipelineSchedulerState.reconciliationCursor)
    : eq(pipelineSchedulerState.reconciliationCursor, params.expectedCursor);
  const advancesProgress = params.wrap || params.nextCursor !== params.expectedCursor;
  const update = {
    reconciliationCursor: params.nextCursor,
    updatedAt: sql`clock_timestamp()`,
    ...(advancesProgress ? {
      reconciliationProgressAt: sql`clock_timestamp()`,
      reconciliationProgressCount: sql`${pipelineSchedulerState.reconciliationProgressCount} + 1`,
    } : {}),
    ...(params.wrap
      ? { reconciliationCycle: sql`${pipelineSchedulerState.reconciliationCycle} + 1` }
      : {}),
  };
  const [state] = await db.update(pipelineSchedulerState).set(update).where(and(
    eq(pipelineSchedulerState.id, PIPELINE_SCHEDULER_STATE_ID),
    eq(pipelineSchedulerState.ownerToken, params.ownerToken),
    sql<boolean>`${pipelineSchedulerState.leaseExpiresAt} > clock_timestamp()`,
    expectedCursor
  )).returning({
    reconciliationCursor: pipelineSchedulerState.reconciliationCursor,
    reconciliationCycle: pipelineSchedulerState.reconciliationCycle,
    reconciliationProgressAt: pipelineSchedulerState.reconciliationProgressAt,
    reconciliationProgressCount: pipelineSchedulerState.reconciliationProgressCount,
  });
  return state ?? null;
}
