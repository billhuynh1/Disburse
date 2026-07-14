import 'server-only';

import { createRenderableRenderConfigsForEditConfig } from '@/lib/disburse/brand-template-service';
import {
  applyFacecamResultToClipEditConfig,
  getRenderedClipVariantForEditConfig,
} from '@/lib/disburse/clip-edit-config-service';
import { buildJobIdempotencyKey } from '@/lib/disburse/job-identity';
import { insertOrReuseReconciliationJob } from '@/lib/disburse/job-service';
import { createFacecamDetectionNotification } from '@/lib/disburse/notification-service';
import {
  FacecamDetectionStatus,
  JobStatus,
  JobType,
  RenderedClipLayout,
  type FormatRenderedClipShortFormJobPayload,
} from '@/lib/db/schema';
import { db } from '@/lib/db/drizzle';

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function replayCandidateFacecamTerminalProjection(params: {
  candidate: {
    id: number;
    userId: number;
    contentPackId: number;
    sourceAssetId: number;
    generationRunId: string;
  };
  status: FacecamDetectionStatus;
  failureReason?: string | null;
  debugReason?: string | null;
  executor: DbTransaction;
}) {
  const editConfig = await applyFacecamResultToClipEditConfig({
    clipCandidateId: params.candidate.id,
    userId: params.candidate.userId,
    generationRunId: params.candidate.generationRunId,
    status: params.status,
    failureReason: params.failureReason,
    debugReason: params.debugReason,
  }, params.executor);
  const renderConfigs = await createRenderableRenderConfigsForEditConfig(
    editConfig,
    params.executor
  );
  const effectiveConfigs = renderConfigs.length > 0 ? renderConfigs : [editConfig];
  const jobIds: number[] = [];

  for (const config of effectiveConfigs) {
    const payload: FormatRenderedClipShortFormJobPayload = {
      clipCandidateId: config.clipCandidateId,
      contentPackId: config.contentPackId,
      sourceAssetId: config.sourceAssetId,
      userId: config.userId,
      generationRunId: config.generationRunId,
      renderConfigId: 'configVersion' in config ? undefined : config.id,
      variant: getRenderedClipVariantForEditConfig(config),
      layout: config.layout as RenderedClipLayout,
      captionsEnabled: config.captionsEnabled,
      captionFontAssetId: config.captionFontAssetId ?? undefined,
      editConfigHash: config.configHash,
    };
    const job = await insertOrReuseReconciliationJob({
      type: JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
      status: JobStatus.PENDING,
      idempotencyKey: buildJobIdempotencyKey(
        JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
        payload
      ),
      payload,
    }, params.executor);
    jobIds.push(job.id);
  }

  await createFacecamDetectionNotification(params.candidate.id, params.executor);

  return { editConfig, jobIds };
}

export function isTerminalFacecamStatus(status: string) {
  return [
    FacecamDetectionStatus.READY,
    FacecamDetectionStatus.NOT_FOUND,
    FacecamDetectionStatus.FAILED_TIMEOUT,
    FacecamDetectionStatus.FAILED_ABORTED,
    FacecamDetectionStatus.FAILED_NETWORK,
    FacecamDetectionStatus.FAILED_HTTP,
    FacecamDetectionStatus.FAILED_INVALID_RESPONSE,
    FacecamDetectionStatus.FAILED,
  ].includes(status as FacecamDetectionStatus);
}
