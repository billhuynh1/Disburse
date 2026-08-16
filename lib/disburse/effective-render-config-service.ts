import 'server-only';

import { createHash } from 'node:crypto';

import { and, desc, eq, sql } from 'drizzle-orm';

import { db } from '@/lib/db/drizzle';
import {
  clipCandidateFacecamDetections,
  clipCandidateFacecamDetectionRuns,
  clipCandidates,
  clipRenderConfigs,
  contentPacks,
  FacecamDetectionStatus,
  JobFailureClass,
  JobStatus,
  JobType,
  jobs,
  RenderedClipLayout,
  RenderedClipVariant,
  renderedClips,
  type NewClipRenderConfig,
} from '@/lib/db/schema';
import { getRenderedClipVariantForEditConfig } from '@/lib/disburse/clip-edit-config-service';
import {
  classifyShortFormGenerationMode,
  requireSnapshotGenerationMode,
} from '@/lib/disburse/short-form-generation-mode-service';
import { buildJobIdempotencyKey } from '@/lib/disburse/job-identity';
import { insertOrReuseReconciliationJob } from '@/lib/disburse/job-service';

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(object[key])}`
  ).join(',')}}`;
}

export function buildEffectiveRenderConfigHash(input: Record<string, unknown>) {
  return createHash('sha256')
    .update(stableJson({ format: 'effective_render_config_v1', ...input }))
    .digest('hex');
}

function layoutRatio(layout: RenderedClipLayout) {
  if (layout === RenderedClipLayout.FACECAM_TOP_50) return '50_50';
  if (layout === RenderedClipLayout.FACECAM_TOP_40) return '40_60';
  if (layout === RenderedClipLayout.FACECAM_TOP_30) return '30_70';
  return null;
}

export async function resolveCandidateEffectiveRenderConfig(params: {
  clipCandidateId: number;
  contentPackId: number;
  sourceAssetId: number;
  userId: number;
  generationRunId: string;
  facecamStatus: FacecamDetectionStatus;
  facecamDetectionId?: number | null;
  executor?: DbTransaction;
}) {
  const execute = async (tx: DbTransaction) => {
    const [candidate] = await tx.select().from(clipCandidates).where(and(
      eq(clipCandidates.id, params.clipCandidateId),
      eq(clipCandidates.userId, params.userId)
    )).for('update').limit(1);
    const [pack] = await tx.select().from(contentPacks).where(and(
      eq(contentPacks.id, params.contentPackId),
      eq(contentPacks.userId, params.userId)
    )).for('update').limit(1);
    if (!candidate || !pack ||
      candidate.contentPackId !== params.contentPackId ||
      candidate.sourceAssetId !== params.sourceAssetId ||
      candidate.generationRunId !== params.generationRunId ||
      pack.sourceAssetId !== params.sourceAssetId ||
      pack.generationRunId !== params.generationRunId) {
      throw new Error('Candidate ownership or generation run is no longer current.');
    }

    const mode = requireSnapshotGenerationMode(await classifyShortFormGenerationMode({
      generationRunId: params.generationRunId,
      contentPackId: params.contentPackId,
    }, tx));
    const snapshot = mode.snapshot;
    const facecamStatus = candidate.facecamDetectionStatus as FacecamDetectionStatus;
    const terminal = [
      FacecamDetectionStatus.READY,
      FacecamDetectionStatus.NOT_FOUND,
      FacecamDetectionStatus.FAILED_TIMEOUT,
      FacecamDetectionStatus.FAILED_ABORTED,
      FacecamDetectionStatus.FAILED_NETWORK,
      FacecamDetectionStatus.FAILED_HTTP,
      FacecamDetectionStatus.FAILED_INVALID_RESPONSE,
      FacecamDetectionStatus.FAILED,
    ].includes(facecamStatus);
    if (snapshot.facecam.detectionEnabled && !terminal) {
      throw new Error('Facecam detection must be terminal before resolving a render config.');
    }

    const facecamDetection = snapshot.facecam.detectionEnabled &&
      facecamStatus === FacecamDetectionStatus.READY && params.facecamDetectionId
      ? await tx.query.clipCandidateFacecamDetections.findFirst({
          where: and(
            eq(clipCandidateFacecamDetections.id, params.facecamDetectionId),
            eq(clipCandidateFacecamDetections.userId, candidate.userId),
            eq(clipCandidateFacecamDetections.sourceAssetId, candidate.sourceAssetId),
            eq(clipCandidateFacecamDetections.clipCandidateId, candidate.id),
            eq(clipCandidateFacecamDetections.generationRunId, params.generationRunId),
            eq(clipCandidateFacecamDetections.detectorVersion, snapshot.facecam.detectorVersion),
            eq(clipCandidateFacecamDetections.startTimeMs, candidate.startTimeMs),
            eq(clipCandidateFacecamDetections.endTimeMs, candidate.endTimeMs)
          ),
        })
      : null;
    if (snapshot.facecam.detectionEnabled && facecamStatus === FacecamDetectionStatus.READY && !facecamDetection) {
      throw new Error('facecam_detection_authority_mismatch');
    }
    if (facecamDetection) {
      const detectionRun = facecamDetection.detectionRunId
        ? await tx.query.clipCandidateFacecamDetectionRuns.findFirst({
            where: and(
              eq(clipCandidateFacecamDetectionRuns.id, facecamDetection.detectionRunId),
              eq(clipCandidateFacecamDetectionRuns.userId, candidate.userId),
              eq(clipCandidateFacecamDetectionRuns.sourceAssetId, candidate.sourceAssetId),
              eq(clipCandidateFacecamDetectionRuns.contentPackId, candidate.contentPackId),
              eq(clipCandidateFacecamDetectionRuns.clipCandidateId, candidate.id),
              eq(clipCandidateFacecamDetectionRuns.generationRunId, params.generationRunId),
              eq(clipCandidateFacecamDetectionRuns.detectorVersion, snapshot.facecam.detectorVersion),
              eq(clipCandidateFacecamDetectionRuns.startTimeMs, candidate.startTimeMs),
              eq(clipCandidateFacecamDetectionRuns.endTimeMs, candidate.endTimeMs),
              eq(clipCandidateFacecamDetectionRuns.status, FacecamDetectionStatus.READY)
            ),
          })
        : null;
      const validRegion = facecamDetection.frameWidth > 0 && facecamDetection.frameHeight > 0 &&
        facecamDetection.widthPx > 0 && facecamDetection.heightPx > 0 &&
        facecamDetection.xPx >= 0 && facecamDetection.yPx >= 0 &&
        facecamDetection.xPx + facecamDetection.widthPx <= facecamDetection.frameWidth &&
        facecamDetection.yPx + facecamDetection.heightPx <= facecamDetection.frameHeight;
      if (!detectionRun || !validRegion) throw new Error('facecam_detection_authority_mismatch');
    }
    const usableFacecam = Boolean(facecamDetection);
    const layout = (usableFacecam
      ? snapshot.facecam.preferredLayout
      : snapshot.facecam.fallbackLayout) as RenderedClipLayout;
    const values = {
      userId: candidate.userId,
      contentPackId: candidate.contentPackId,
      sourceAssetId: candidate.sourceAssetId,
      clipCandidateId: candidate.id,
      generationRunId: params.generationRunId,
      aspectRatio: snapshot.render.aspectRatio,
      layout,
      layoutRatio: layoutRatio(layout),
      captionsEnabled: snapshot.render.captionsEnabled,
      captionStyle: snapshot.render.captionStyle,
      captionFontAssetId: snapshot.render.captionFontAssetId,
      captionFontFamily: snapshot.render.captionFontFamily,
      captionFontColor: snapshot.render.captionFontColor,
      captionHighlightColor: snapshot.render.captionHighlightColor,
      captionPosition: snapshot.render.captionPosition,
      captionAnimation: snapshot.render.captionAnimation,
      brandTemplateId: snapshot.brandTemplateId,
      overlayLogoAssetId: snapshot.render.overlayLogoAssetId,
      ctaUrl: snapshot.render.ctaUrl,
      introVideoAssetId: snapshot.render.introVideoAssetId,
      outroVideoAssetId: snapshot.render.outroVideoAssetId,
      cropSettings: snapshot.render.cropSettings,
      facecamDetectionId: facecamDetection?.id ?? null,
      facecamDetected: usableFacecam,
      autoEditPreset: snapshot.render.autoEditPreset,
    };
    const configHash = buildEffectiveRenderConfigHash({
      candidate: { id: candidate.id, startTimeMs: candidate.startTimeMs, endTimeMs: candidate.endTimeMs, durationMs: candidate.durationMs },
      ...values,
    });
    const [existing] = await tx.select().from(clipRenderConfigs).where(and(
      eq(clipRenderConfigs.clipCandidateId, candidate.id),
      eq(clipRenderConfigs.generationRunId, params.generationRunId),
      eq(clipRenderConfigs.configHash, configHash)
    )).for('update').limit(1);
    const config = existing ?? (await tx.insert(clipRenderConfigs).values({
      ...values,
      configHash,
    } satisfies NewClipRenderConfig).returning())[0]!;
    await tx.update(clipCandidates).set({ currentRenderConfigId: config.id, updatedAt: new Date() })
      .where(eq(clipCandidates.id, candidate.id));

    const payload = {
      clipCandidateId: candidate.id,
      contentPackId: candidate.contentPackId,
      sourceAssetId: candidate.sourceAssetId,
      userId: candidate.userId,
      generationRunId: params.generationRunId,
      renderConfigId: config.id,
      variant: getRenderedClipVariantForEditConfig(config),
      layout: config.layout as RenderedClipLayout,
      captionsEnabled: config.captionsEnabled,
      captionFontAssetId: config.captionFontAssetId ?? undefined,
      editConfigHash: config.configHash,
    };
    const idempotencyKey = buildJobIdempotencyKey(JobType.FORMAT_RENDERED_CLIP_SHORT_FORM, payload);
    const jobValues = {
      type: JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
      status: JobStatus.PENDING,
      idempotencyKey,
      payload,
    } as const;
    const readyArtifact = await tx.query.renderedClips.findFirst({
      where: and(
        eq(renderedClips.clipCandidateId, candidate.id),
        eq(renderedClips.generationRunId, params.generationRunId),
        eq(renderedClips.clipRenderConfigId, config.id),
        eq(renderedClips.status, 'ready'),
        sql`${renderedClips.deletedAt} is null`
      ),
    });
    const exactJobs = await tx.select().from(jobs).where(and(
      eq(jobs.type, JobType.FORMAT_RENDERED_CLIP_SHORT_FORM),
      sql`payload->>'clipCandidateId' = ${String(candidate.id)}`,
      sql`payload->>'contentPackId' = ${String(candidate.contentPackId)}`,
      sql`payload->>'sourceAssetId' = ${String(candidate.sourceAssetId)}`,
      sql`payload->>'generationRunId' = ${params.generationRunId}`,
      sql`payload->>'renderConfigId' = ${String(config.id)}`
    )).orderBy(desc(jobs.recoveryAttempt), desc(jobs.id));
    const activeJob = exactJobs.find((item) =>
      item.status === JobStatus.PENDING || item.status === JobStatus.PROCESSING
    );
    const latestJob = exactJobs[0];
    let job = activeJob ?? latestJob;

    if (!readyArtifact && !activeJob) {
      if (!latestJob) {
        job = await insertOrReuseReconciliationJob(jobValues, tx);
      } else if (
        latestJob.failureClass === JobFailureClass.SAFE_NO_EXTERNAL_EFFECT &&
        latestJob.recoveryAttempt < latestJob.maxAttempts
      ) {
        const nextAttempt = latestJob.recoveryAttempt + 1;
        job = await insertOrReuseReconciliationJob({
          ...jobValues,
          idempotencyKey: `${idempotencyKey}:recovery:${nextAttempt}`,
          parentJobId: latestJob.id,
          rootJobId: latestJob.rootJobId ?? latestJob.id,
          recoveryAttempt: nextAttempt,
          recoveryMode: 'retry',
        }, tx);
      }
    }

    return { config, job: job!, snapshot, usableFacecam };
  };
  return params.executor ? await execute(params.executor) : await db.transaction(execute);
}
