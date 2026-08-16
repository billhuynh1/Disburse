import 'server-only';

import { and, eq } from 'drizzle-orm';

import { createRenderableRenderConfigsForEditConfig } from '@/lib/disburse/brand-template-service';
import {
  applyFacecamResultToClipEditConfig,
  getRenderedClipVariantForEditConfig,
} from '@/lib/disburse/clip-edit-config-service';
import { buildJobIdempotencyKey } from '@/lib/disburse/job-identity';
import { insertOrReuseReconciliationJob } from '@/lib/disburse/job-service';
import { createFacecamDetectionNotification } from '@/lib/disburse/notification-service';
import {
  clipCandidateFacecamDetectionRuns,
  clipCandidateFacecamDetections,
  clipCandidates,
  FacecamDetectionStatus,
  JobStatus,
  JobType,
  RenderedClipLayout,
  type FormatRenderedClipShortFormJobPayload,
} from '@/lib/db/schema';
import { db } from '@/lib/db/drizzle';
import { resolveCandidateEffectiveRenderConfig } from '@/lib/disburse/effective-render-config-service';
import { classifyShortFormGenerationMode } from '@/lib/disburse/short-form-generation-mode-service';

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
  detectionRunIdentity: number | {
    id: number;
    generationRunId: string;
    detectorVersion: string;
    startTimeMs: number;
    endTimeMs: number;
  };
  failureReason?: string | null;
  debugReason?: string | null;
  executor: DbTransaction;
}) {
  const [persistedCandidate] = await params.executor
    .select()
    .from(clipCandidates)
    .where(and(
      eq(clipCandidates.id, params.candidate.id),
      eq(clipCandidates.userId, params.candidate.userId),
      eq(clipCandidates.contentPackId, params.candidate.contentPackId),
      eq(clipCandidates.sourceAssetId, params.candidate.sourceAssetId),
      eq(clipCandidates.generationRunId, params.candidate.generationRunId)
    ))
    .for('update')
    .limit(1);
  if (!persistedCandidate) throw new Error('candidate_facecam_authority_mismatch');

  const mode = await classifyShortFormGenerationMode({
    generationRunId: persistedCandidate.generationRunId,
    contentPackId: persistedCandidate.contentPackId,
  }, params.executor);

  if (mode.kind === 'invalid_snapshot_reference') {
    throw new Error(mode.code);
  }

  if (mode.kind === 'snapshot') {
    if (typeof params.detectionRunIdentity !== 'number') {
      throw new Error('snapshot_facecam_detection_run_identity_required');
    }

    const candidate = persistedCandidate;

    const [run] = await params.executor
      .select()
      .from(clipCandidateFacecamDetectionRuns)
      .where(and(
        eq(clipCandidateFacecamDetectionRuns.id, params.detectionRunIdentity),
        eq(clipCandidateFacecamDetectionRuns.userId, candidate.userId),
        eq(clipCandidateFacecamDetectionRuns.sourceAssetId, candidate.sourceAssetId),
        eq(clipCandidateFacecamDetectionRuns.contentPackId, candidate.contentPackId),
        eq(clipCandidateFacecamDetectionRuns.clipCandidateId, candidate.id),
        eq(clipCandidateFacecamDetectionRuns.generationRunId, candidate.generationRunId),
        eq(clipCandidateFacecamDetectionRuns.detectorVersion, mode.snapshot.facecam.detectorVersion),
        eq(clipCandidateFacecamDetectionRuns.startTimeMs, candidate.startTimeMs),
        eq(clipCandidateFacecamDetectionRuns.endTimeMs, candidate.endTimeMs)
      ))
      .for('update')
      .limit(1);
    if (!run || !isTerminalFacecamStatus(run.status)) {
      throw new Error('snapshot_facecam_terminal_authority_mismatch');
    }

    const detection = await params.executor.query.clipCandidateFacecamDetections.findFirst({
      where: and(
        eq(clipCandidateFacecamDetections.detectionRunId, run.id),
        eq(clipCandidateFacecamDetections.userId, candidate.userId),
        eq(clipCandidateFacecamDetections.sourceAssetId, candidate.sourceAssetId),
        eq(clipCandidateFacecamDetections.clipCandidateId, candidate.id),
        eq(clipCandidateFacecamDetections.generationRunId, candidate.generationRunId),
        eq(clipCandidateFacecamDetections.detectorVersion, mode.snapshot.facecam.detectorVersion),
        eq(clipCandidateFacecamDetections.startTimeMs, candidate.startTimeMs),
        eq(clipCandidateFacecamDetections.endTimeMs, candidate.endTimeMs)
      ),
    });
    const persistedStatus = mode.snapshot.facecam.detectionEnabled
      ? run.status as FacecamDetectionStatus
      : FacecamDetectionStatus.NOT_FOUND;
    if (persistedStatus === FacecamDetectionStatus.READY && !detection) {
      throw new Error('facecam_detection_authority_mismatch');
    }
    const failureReason = persistedStatus === FacecamDetectionStatus.READY ||
      persistedStatus === FacecamDetectionStatus.NOT_FOUND
      ? null
      : run.failureReason;
    const debugReason = mode.snapshot.facecam.detectionEnabled
      ? (persistedStatus === FacecamDetectionStatus.READY || persistedStatus === FacecamDetectionStatus.NOT_FOUND
          ? null
          : run.debugReason)
      : 'facecam_detection_disabled';
    await params.executor.update(clipCandidates).set({
      facecamDetectionStatus: persistedStatus,
      facecamDetectionFailureReason: failureReason,
      facecamDetectionDebugReason: debugReason,
      facecamDetectedAt: persistedStatus === FacecamDetectionStatus.READY ? (run.completedAt ?? new Date()) : null,
      updatedAt: new Date(),
    }).where(eq(clipCandidates.id, params.candidate.id));
    const resolved = await resolveCandidateEffectiveRenderConfig({
      clipCandidateId: params.candidate.id,
      contentPackId: params.candidate.contentPackId,
      sourceAssetId: params.candidate.sourceAssetId,
      userId: params.candidate.userId,
      generationRunId: params.candidate.generationRunId,
      facecamStatus: persistedStatus,
      facecamDetectionId: persistedStatus === FacecamDetectionStatus.READY ? detection?.id ?? null : null,
      executor: params.executor,
    });
    await createFacecamDetectionNotification(
      params.candidate.id,
      run.id,
      params.executor
    );
    return { editConfig: null, jobIds: [resolved.job.id], renderConfigs: [resolved.config] };
  }

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
      editConfigId: 'configVersion' in config ? config.id : undefined,
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

  await createFacecamDetectionNotification(
    params.candidate.id,
    params.detectionRunIdentity,
    params.executor
  );

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
