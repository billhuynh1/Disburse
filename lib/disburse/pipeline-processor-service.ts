import 'server-only';

import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';

import { db } from '@/lib/db/drizzle';
import { jobs, JobStatus, JobType, projects } from '@/lib/db/schema';
import {
  claimNextJob,
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
export const PIPELINE_FINALIZATION_RESERVE_MS = 30_000;
const RECONCILIATION_PROJECT_RESERVE_MS = 5_000;

export type PipelineProcessorOrigin = 'internal' | 'cron';
export type PipelineProcessorStopReason =
  | 'queue_empty'
  | 'max_jobs'
  | 'max_runtime'
  | 'reconciliation_budget'
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
  triggerFollowUp?: () => void;
};

function configuredTimeout(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function getPipelineJobTimeoutMs(type: JobType) {
  switch (type) {
    case JobType.RENDER_CLIP_CANDIDATE:
    case JobType.FORMAT_RENDERED_CLIP_SHORT_FORM:
      return configuredTimeout('RENDER_TIMEOUT_MS', 600_000);
    case JobType.DETECT_CLIP_FACECAM:
      return configuredTimeout('MEDIA_API_FACECAM_TIMEOUT_MS', 120_000);
    case JobType.TRANSCRIBE_SOURCE_ASSET:
      return configuredTimeout('OPENAI_TRANSCRIPTION_TIMEOUT_MS', 300_000);
    case JobType.GENERATE_SHORT_FORM_PACK:
      return configuredTimeout('OPENAI_SHORT_FORM_TIMEOUT_MS', 180_000);
    case JobType.INGEST_YOUTUBE_SOURCE_ASSET:
      return configuredTimeout('YOUTUBE_INGESTION_TIMEOUT_MS', 300_000);
    case JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL:
      return configuredTimeout('THUMBNAIL_EXTRACTION_TIMEOUT_MS', 120_000);
    case JobType.PUBLISH_RENDERED_CLIP:
      return configuredTimeout('PUBLISH_TIMEOUT_MS', 120_000);
    default:
      return 120_000;
  }
}

export function validatePipelineOperationTimeouts() {
  const routeBudgetMs = PIPELINE_ROUTE_MAX_DURATION_SECONDS * 1_000;
  for (const type of Object.values(JobType)) {
    const timeoutMs = getPipelineJobTimeoutMs(type);
    if (timeoutMs + PIPELINE_FINALIZATION_RESERVE_MS > routeBudgetMs) {
      throw new Error(`Configured ${type} timeout exceeds the processing route budget.`);
    }
  }
}

function safeResult(
  stopReason: PipelineProcessorStopReason,
  values: Omit<PipelineProcessorResult, 'stopReason'>
): PipelineProcessorResult {
  return { stopReason, ...values };
}

async function hasRunnablePipelineJob() {
  const [row] = await db.select({ id: jobs.id }).from(jobs).where(and(
    eq(jobs.status, JobStatus.PENDING),
    isNull(jobs.cancellationRequestedAt),
    sql<boolean>`${jobs.availableAt} <= clock_timestamp()`,
  )).limit(1);
  return Boolean(row);
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
  let heartbeatInFlight: Promise<void> | null = null;
  let ownership: Awaited<ReturnType<typeof acquirePipelineProcessor>> = null;
  let stopReason: PipelineProcessorStopReason = 'queue_empty';

  try {
    validatePipelineOperationTimeouts();
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
        ...productionPipelineProcessingRuntime,
        downstream: { trigger: () => undefined },
      };

      while (!ownershipLost && stopReason !== 'max_runtime') {
        if (processedJobs >= maxJobs) {
          stopReason = 'max_jobs';
          break;
        }
        const remainingMs = deadline - now();
        const allowedJobTypes = Object.values(JobType).filter((type) =>
          getPipelineJobTimeoutMs(type) + PIPELINE_FINALIZATION_RESERVE_MS <= remainingMs
        );
        if (allowedJobTypes.length === 0) {
          stopReason = await hasRunnablePipelineJob() ? 'max_runtime' : (
            reconciliationNeedsFollowUp ? 'reconciliation_budget' : 'queue_empty'
          );
          break;
        }

        const job = await claimNextJob({
          schedulerOwnerToken: ownership.ownerToken,
          recoverExpiredLeases: false,
          allowedJobTypes,
        });
        if (!job) {
          if (!await hasPipelineProcessorOwnership(ownership.ownerToken)) {
            ownershipLost = true;
            stopReason = 'processor_busy';
          } else {
            const runnableWorkRemains = await hasRunnablePipelineJob();
            stopReason = runnableWorkRemains
              ? 'max_runtime'
              : reconciliationNeedsFollowUp
                ? 'reconciliation_budget'
                : 'queue_empty';
          }
          break;
        }

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
      await releasePipelineProcessor(ownership.ownerToken).catch((error) => {
        console.error('pipeline_processor.release_failed', error);
        stopReason = 'fatal_error';
      });
    }
  }

  if (
    options.origin === 'internal' &&
    !ownershipLost &&
    stopReason !== 'fatal_error' &&
    (stopReason === 'max_jobs' || stopReason === 'max_runtime' || stopReason === 'reconciliation_budget')
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
