import { JobType } from '@/lib/db/schema';
import type { JobExecutionAuthority } from '@/lib/disburse/job-execution-authorization';

export const PIPELINE_ROUTE_MAX_DURATION_MS = 800_000;
export const PIPELINE_FINALIZATION_RESERVE_MS = 30_000;
export const JOB_OPERATION_DEADLINE_EXCEEDED_CODE =
  'JOB_OPERATION_DEADLINE_EXCEEDED';

export class JobOperationDeadlineExceededError extends Error {
  readonly code = JOB_OPERATION_DEADLINE_EXCEEDED_CODE;

  constructor() {
    super('The job operation deadline expired before its result could be accepted.');
    this.name = 'JobOperationDeadlineExceededError';
  }
}

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
  }
}

export function validatePipelineOperationTimeouts(maxRuntimeMs: number) {
  if (maxRuntimeMs + PIPELINE_FINALIZATION_RESERVE_MS > PIPELINE_ROUTE_MAX_DURATION_MS) {
    throw new Error('Pipeline processor runtime exceeds the processing route budget.');
  }
  for (const type of Object.values(JobType)) {
    const requiredRuntimeMs =
      getPipelineJobTimeoutMs(type) + PIPELINE_FINALIZATION_RESERVE_MS;
    if (requiredRuntimeMs > PIPELINE_ROUTE_MAX_DURATION_MS) {
      throw new Error(`Configured ${type} timeout exceeds the processing route budget.`);
    }
    if (requiredRuntimeMs > maxRuntimeMs) {
      throw new Error(`Configured ${type} timeout exceeds the processor runtime budget.`);
    }
  }
}

export function createPipelineOperationSignal(
  type: JobType,
  authoritySignal?: AbortSignal
) {
  const deadlineSignal = AbortSignal.timeout(getPipelineJobTimeoutMs(type));
  return authoritySignal
    ? AbortSignal.any([authoritySignal, deadlineSignal])
    : deadlineSignal;
}

export function getJobOperationSignal(authority: JobExecutionAuthority) {
  return authority.operationSignal ?? authority.signal;
}

export function assertJobOperationDeadline(authority: JobExecutionAuthority) {
  if (authority.operationSignal?.aborted) {
    throw new JobOperationDeadlineExceededError();
  }
}

export function composeOperationSignal(
  operationSignal: AbortSignal | undefined,
  localSignal: AbortSignal
) {
  return operationSignal
    ? AbortSignal.any([operationSignal, localSignal])
    : localSignal;
}
