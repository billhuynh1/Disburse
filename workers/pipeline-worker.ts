import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  runPipelineProcessor,
  type PipelineProcessorResult,
} from '@/lib/disburse/pipeline-processor-service';
import { classifyOperationalFailure } from '@/lib/disburse/operational-events';

export const DEFAULT_PIPELINE_WORKER_IDLE_POLL_MS = 2_000;
export const DEFAULT_PIPELINE_WORKER_ERROR_POLL_MS = 5_000;

type WorkerLogger = Pick<Console, 'error' | 'info'>;
type WorkerProcessor = (options: {
  origin: 'internal';
  enableFollowUp: false;
}) => Promise<PipelineProcessorResult>;

export type PipelineWorkerOptions = {
  processor?: WorkerProcessor;
  sleep?: (milliseconds: number) => Promise<void>;
  logger?: WorkerLogger;
  idlePollMs?: number;
  errorPollMs?: number;
};

function sleep(milliseconds: number) {
  return new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function requiredEnvironment(name: string) {
  if (!process.env[name]?.trim()) {
    throw new Error(`${name} environment variable is not set.`);
  }
}

export function validatePipelineWorkerConfiguration() {
  if (process.env.DISBURSE_PROCESSOR_MODE?.trim() !== 'worker') {
    throw new Error('DISBURSE_PROCESSOR_MODE must be set to worker for the pipeline worker.');
  }

  for (const name of [
    'POSTGRES_URL',
    'OPENAI_API_KEY',
    'S3_UPLOAD_ACCESS_KEY_ID',
    'S3_UPLOAD_SECRET_ACCESS_KEY',
    'S3_UPLOAD_BUCKET',
    'S3_UPLOAD_REGION',
    'FFMPEG_PATH',
    'FFPROBE_PATH',
    'MEDIA_API_BASE_URL',
    'MEDIA_API_SECRET',
    'DISBURSE_DEPLOYMENT_ENV',
  ]) {
    requiredEnvironment(name);
  }
}

export class PipelineWorker {
  private shutdownRequested = false;
  private idleLogged = false;
  private readonly processor: WorkerProcessor;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly logger: WorkerLogger;
  private readonly idlePollMs: number;
  private readonly errorPollMs: number;

  constructor(options: PipelineWorkerOptions = {}) {
    this.processor = options.processor ?? runPipelineProcessor;
    this.sleep = options.sleep ?? sleep;
    this.logger = options.logger ?? console;
    this.idlePollMs = Math.max(1, options.idlePollMs ?? DEFAULT_PIPELINE_WORKER_IDLE_POLL_MS);
    this.errorPollMs = Math.max(1, options.errorPollMs ?? DEFAULT_PIPELINE_WORKER_ERROR_POLL_MS);
  }

  requestShutdown() {
    this.shutdownRequested = true;
  }

  async run() {
    this.logger.info(JSON.stringify({ event: 'pipeline.worker_started' }));
    while (!this.shutdownRequested) {
      try {
        this.logger.info(JSON.stringify({ event: 'pipeline.worker_processor_started' }));
        const result = await this.processor({ origin: 'internal', enableFollowUp: false });
        this.logger.info(JSON.stringify({
          event: 'pipeline.worker_processor_completed',
          invocationId: result.invocationId,
          stopReason: result.stopReason,
          processedJobs: result.processedJobs,
        }));

        if (this.shutdownRequested) break;
        if (result.stopReason === 'fatal_error') {
          this.logger.error(JSON.stringify({
            event: 'pipeline.worker_loop_error',
            invocationId: result.invocationId,
            failureClass: result.failureClass ?? 'unknown',
            failureCode: result.failureCode ?? 'unclassified_failure',
          }));
          await this.sleep(this.errorPollMs);
        } else if (result.stopReason === 'queue_empty' || result.processedJobs === 0) {
          if (!this.idleLogged) {
            this.logger.info(JSON.stringify({ event: 'pipeline.worker_idle' }));
            this.idleLogged = true;
          }
          await this.sleep(this.idlePollMs);
        } else {
          this.idleLogged = false;
        }
      } catch (error) {
        const failure = classifyOperationalFailure(error);
        this.logger.error(JSON.stringify({
          event: 'pipeline.worker_loop_error',
          ...failure,
        }));
        if (!this.shutdownRequested) await this.sleep(this.errorPollMs);
      }
    }
    this.logger.info(JSON.stringify({ event: 'pipeline.worker_stopped' }));
  }
}

export async function main() {
  validatePipelineWorkerConfiguration();
  const worker = new PipelineWorker();
  const requestShutdown = (signal: 'SIGINT' | 'SIGTERM') => {
    console.info(JSON.stringify({ event: 'pipeline.worker_shutdown_requested', signal }));
    worker.requestShutdown();
  };
  process.once('SIGINT', () => requestShutdown('SIGINT'));
  process.once('SIGTERM', () => requestShutdown('SIGTERM'));
  await worker.run();
}

const invokedFile = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href;
if (invokedFile === import.meta.url) {
  void main().catch((error) => {
    const failure = classifyOperationalFailure(error);
    console.error(JSON.stringify({ event: 'pipeline.worker_startup_failed', ...failure }));
    process.exitCode = 1;
  });
}
