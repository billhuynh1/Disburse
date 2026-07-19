import 'server-only';

import { asc, gt } from 'drizzle-orm';

import { db } from '@/lib/db/drizzle';
import { JobType, projects } from '@/lib/db/schema';
import {
  claimNextJobWithOutcome,
  recoverExpiredPipelineJobLeases,
  type ClaimedPipelineJob,
} from '@/lib/disburse/job-service';
import { triggerInternalJobProcessing } from '@/lib/disburse/internal-job-trigger';
import {
  processClaimedJob,
  productionPipelineProcessingRuntime,
  type PipelineProcessingRuntime,
} from '@/lib/disburse/pipeline-service';
import { reconcileProjectPipeline } from '@/lib/disburse/pipeline-reconciliation-service';
import {
  getPipelineJobTimeoutMs,
  PIPELINE_FINALIZATION_RESERVE_MS,
  PIPELINE_ORCHESTRATION_HEADROOM_MS,
  PIPELINE_ROUTE_MAX_DURATION_MS,
  validatePipelineOperationTimeouts,
} from '@/lib/disburse/pipeline-operation-deadline';
import {
  acquirePipelineProcessor,
  advancePipelineReconciliationCursor,
  hasPipelineProcessorOwnership,
  heartbeatPipelineProcessor,
  PROCESSOR_HEARTBEAT_INTERVAL_MS,
  releasePipelineProcessor,
} from '@/lib/disburse/pipeline-scheduler-service';

export const PIPELINE_ROUTE_MAX_DURATION_SECONDS = 800;
export const DEFAULT_PIPELINE_PROCESSOR_MAX_JOBS = 10;
export const DEFAULT_PIPELINE_RECONCILIATION_PROJECTS = 10;
export const DEFAULT_PIPELINE_RECOVERY_LIMIT = 100;
export const DEFAULT_PIPELINE_PROCESSOR_MAX_RUNTIME_MS = 720_000;
export const PIPELINE_CONCURRENT_CLAIM_RETRY_LIMIT = 2;
export const PIPELINE_CLAIM_DISPATCH_RESERVE_MS = 5_000;
const RECONCILIATION_PROJECT_RESERVE_MS = 5_000;

export type PipelineProcessorOrigin = 'internal' | 'cron';
export type PipelineProcessorStopReason =
  | 'queue_empty'
  | 'max_jobs'
  | 'max_runtime'
  | 'reconciliation_budget'
  | 'capacity_blocked'
  | 'concurrent_claim'
  | 'processor_busy'
  | 'fatal_error';

export type PipelineProcessorResult = {
  stopReason: PipelineProcessorStopReason;
  processedJobs: number;
  recoveredJobs: number;
  reconciledProjects: number;
  reconciliationCycle: number | null;
  followUpTriggered: boolean;
};

type ProcessorOptions = {
  origin: PipelineProcessorOrigin;
  maxJobs?: number;
  reconciliationProjects?: number;
  recoveryLimit?: number;
  maxRuntimeMs?: number;
  now?: () => number;
  processJob?: (
    job: ClaimedPipelineJob,
    runtime: PipelineProcessingRuntime
  ) => Promise<unknown>;
  processingRuntime?: PipelineProcessingRuntime;
  triggerFollowUp?: () => void;
  releaseOwnership?: typeof releasePipelineProcessor;
  waitForConcurrentClaimRetry?: (attempt: number) => Promise<void>;
};

function safeResult(
  stopReason: PipelineProcessorStopReason,
  values: Omit<PipelineProcessorResult, 'stopReason'>
): PipelineProcessorResult {
  return { stopReason, ...values };
}

export async function runPipelineProcessor(
  options: ProcessorOptions
): Promise<PipelineProcessorResult> {
  const maxJobs = Math.max(1, Math.floor(
    options.maxJobs ?? DEFAULT_PIPELINE_PROCESSOR_MAX_JOBS
  ));
  const reconciliationProjects = Math.max(1, Math.floor(
    options.reconciliationProjects ?? DEFAULT_PIPELINE_RECONCILIATION_PROJECTS
  ));
  const recoveryLimit = Math.max(1, Math.floor(
    options.recoveryLimit ?? DEFAULT_PIPELINE_RECOVERY_LIMIT
  ));
  const maxRuntimeMs = Math.max(1, Math.floor(
    options.maxRuntimeMs ?? DEFAULT_PIPELINE_PROCESSOR_MAX_RUNTIME_MS
  ));
  const now = options.now ?? Date.now;
  const startedAt = now();
  const deadline = startedAt + maxRuntimeMs;
  let processedJobs = 0;
  let recoveredJobs = 0;
  let reconciledProjects = 0;
  let reconciliationCycle: number | null = null;
  let followUpTriggered = false;
  let ownershipLost = false;
  let reconciliationNeedsFollowUp = false;
  let runtimeRetryRecommended = false;
  let heartbeatInFlight: Promise<void> | null = null;
  let ownership: Awaited<ReturnType<typeof acquirePipelineProcessor>> = null;
  let stopReason: PipelineProcessorStopReason = 'queue_empty';

  try {
    validatePipelineOperationTimeouts(maxRuntimeMs);
    ownership = await acquirePipelineProcessor();
    if (!ownership) {
      return safeResult('processor_busy', {
        processedJobs,
        recoveredJobs,
        reconciledProjects,
        reconciliationCycle,
        followUpTriggered,
      });
    }
    reconciliationCycle = ownership.reconciliationCycle;

    const heartbeat = setInterval(() => {
      if (heartbeatInFlight || ownershipLost || !ownership) return;
      heartbeatInFlight = heartbeatPipelineProcessor(ownership.ownerToken)
        .then((renewed) => {
          if (!renewed) ownershipLost = true;
        })
        .catch(() => {
          ownershipLost = true;
        })
        .finally(() => {
          heartbeatInFlight = null;
        });
    }, PROCESSOR_HEARTBEAT_INTERVAL_MS);

    try {
      const cursor = ownership.reconciliationCursor;
      const projectRows = await db.select({ id: projects.id }).from(projects)
        .where(cursor === null ? undefined : gt(projects.id, cursor))
        .orderBy(asc(projects.id))
        .limit(reconciliationProjects + 1);
      const selectedProjects = projectRows.slice(0, reconciliationProjects);
      let reconciliationComplete = true;
      for (const project of selectedProjects) {
        if (deadline - now() < RECONCILIATION_PROJECT_RESERVE_MS) {
          reconciliationComplete = false;
          stopReason = 'max_runtime';
          break;
        }
        await reconcileProjectPipeline(project.id);
        reconciledProjects += 1;
        if (
          ownershipLost ||
          !await hasPipelineProcessorOwnership(ownership.ownerToken)
        ) {
          ownershipLost = true;
          stopReason = 'processor_busy';
          reconciliationComplete = false;
          break;
        }
      }

      if (reconciliationComplete) {
        const hasMore = projectRows.length > reconciliationProjects;
        const nextCursor = hasMore ? selectedProjects.at(-1)?.id ?? cursor : null;
        const advanced = await advancePipelineReconciliationCursor({
          ownerToken: ownership.ownerToken,
          expectedCursor: cursor,
          nextCursor,
          wrap: !hasMore && (cursor !== null || selectedProjects.length > 0),
        });
        if (!advanced) {
          ownershipLost = true;
          stopReason = 'processor_busy';
        } else {
          reconciliationCycle = advanced.reconciliationCycle;
          reconciliationNeedsFollowUp = hasMore;
        }
      }

      if (!ownershipLost && stopReason !== 'max_runtime') {
        recoveredJobs = await recoverExpiredPipelineJobLeases(
          recoveryLimit,
          ownership.ownerToken
        );
      }

      const suppressedRuntime = {
        ...(options.processingRuntime ?? productionPipelineProcessingRuntime),
        downstream: { trigger: () => undefined },
      };

      processing: while (!ownershipLost && stopReason !== 'max_runtime') {
        if (processedJobs >= maxJobs) {
          stopReason = 'max_jobs';
          break;
        }
        let concurrentClaimRetries = 0;
        let claim: Awaited<ReturnType<typeof claimNextJobWithOutcome>>;
        let admissionElapsedMs = 0;
        while (true) {
          if (concurrentClaimRetries > 0) {
            if (processedJobs >= maxJobs) {
              stopReason = 'max_jobs';
              break processing;
            }
            if (deadline <= now()) {
              stopReason = 'max_runtime';
              break processing;
            }
            if (!await hasPipelineProcessorOwnership(ownership.ownerToken)) {
              ownershipLost = true;
              stopReason = 'processor_busy';
              break processing;
            }
          }
          const admissionNow = now();
          admissionElapsedMs = Math.max(0, admissionNow - startedAt);
          const remainingMs = deadline - admissionNow;
          const routeRemainingMs = startedAt + PIPELINE_ROUTE_MAX_DURATION_MS - admissionNow;
          const admissionRemainingMs = Math.max(remainingMs, routeRemainingMs);
          const allowedJobTypes = Object.values(JobType).filter((type) =>
            getPipelineJobTimeoutMs(type) +
              PIPELINE_FINALIZATION_RESERVE_MS +
              PIPELINE_CLAIM_DISPATCH_RESERVE_MS < admissionRemainingMs
          );
          claim = await claimNextJobWithOutcome({
            schedulerOwnerToken: ownership.ownerToken,
            recoverExpiredLeases: false,
            allowedJobTypes,
          });
          if (claim.status !== 'concurrent_claim') break;
          if (concurrentClaimRetries >= PIPELINE_CONCURRENT_CLAIM_RETRY_LIMIT) {
            stopReason = 'concurrent_claim';
            break processing;
          }
          concurrentClaimRetries += 1;
          await options.waitForConcurrentClaimRetry?.(concurrentClaimRetries);
        }
        if (claim.status !== 'claimed') {
          if (claim.status === 'ownership_lost') {
            ownershipLost = true;
            stopReason = 'processor_busy';
          } else if (claim.status === 'capacity_blocked') {
            stopReason = 'capacity_blocked';
          } else if (claim.status === 'runtime_ineligible') {
            stopReason = 'max_runtime';
            const freshInvocationRemainingMs =
              maxRuntimeMs - PIPELINE_ORCHESTRATION_HEADROOM_MS;
            runtimeRetryRecommended =
              admissionElapsedMs <= PIPELINE_ORCHESTRATION_HEADROOM_MS &&
              claim.dueJobTypes.some((type) =>
                getPipelineJobTimeoutMs(type) +
                  PIPELINE_FINALIZATION_RESERVE_MS +
                  PIPELINE_CLAIM_DISPATCH_RESERVE_MS < freshInvocationRemainingMs
              );
          } else if (claim.status === 'queue_empty') {
            stopReason = reconciliationNeedsFollowUp
              ? 'reconciliation_budget'
              : 'queue_empty';
          }
          break;
        }
        const job = claim.job;

        await (options.processJob ?? processClaimedJob)(job, suppressedRuntime);
        processedJobs += 1;
        if (heartbeatInFlight) await heartbeatInFlight;
        if (ownershipLost || !await hasPipelineProcessorOwnership(ownership.ownerToken)) {
          ownershipLost = true;
          stopReason = 'processor_busy';
          break;
        }
      }
    } finally {
      clearInterval(heartbeat);
      if (heartbeatInFlight) await heartbeatInFlight;
    }
  } catch (error) {
    stopReason = 'fatal_error';
    console.error('pipeline_processor.fatal_error', error);
  } finally {
    if (ownership) {
      try {
        const released = await (
          options.releaseOwnership ?? releasePipelineProcessor
        )(ownership.ownerToken);
        if (!released) {
          ownershipLost = true;
          if (stopReason !== 'fatal_error') stopReason = 'processor_busy';
        }
      } catch (error) {
        console.error('pipeline_processor.release_failed', error);
        stopReason = 'fatal_error';
      }
    }
  }

  if (
    options.origin === 'internal' &&
    !ownershipLost &&
    stopReason !== 'fatal_error' &&
    (
      stopReason === 'max_jobs' ||
      stopReason === 'reconciliation_budget' ||
      (stopReason === 'max_runtime' && runtimeRetryRecommended)
    )
  ) {
    try {
      (options.triggerFollowUp ?? triggerInternalJobProcessing)();
      followUpTriggered = true;
    } catch (error) {
      console.error('pipeline_processor.follow_up_failed', error);
    }
  }

  return safeResult(stopReason, {
    processedJobs,
    recoveredJobs,
    reconciledProjects,
    reconciliationCycle,
    followUpTriggered,
  });
}
