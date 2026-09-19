import 'server-only';

import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import {
  clipCandidates, renderedClips, JobType, RenderedClipLayout,
  RenderedClipStatus, RenderedClipVariant, type Job,
} from '@/lib/db/schema';
import { renderClipCandidateJobPayloadSchema, formatRenderedClipShortFormJobPayloadSchema } from '@/lib/disburse/job-payload-schema';
import { classifyShortFormGenerationMode } from '@/lib/disburse/short-form-generation-mode-service';
import type { JobEffectCheckpointResult } from '@/lib/disburse/job-effect-checkpoint-schema';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function isRenderJob(job: Pick<Job, 'type'>) {
  return job.type === JobType.RENDER_CLIP_CANDIDATE ||
    job.type === JobType.FORMAT_RENDERED_CLIP_SHORT_FORM;
}

// Call inside the job's authorized transaction: its candidate and job locks fence
// result replacement and lease reclaim while this postcondition is checked.
export async function requireReadyRenderJobResult(
  tx: Transaction,
  job: Job,
  result?: JobEffectCheckpointResult
) {
  if (!isRenderJob(job)) throw new Error('render_result_identity_invalid');
  const format = job.type === JobType.FORMAT_RENDERED_CLIP_SHORT_FORM
    ? formatRenderedClipShortFormJobPayloadSchema.parse(job.payload) : null;
  const payload = format ?? renderClipCandidateJobPayloadSchema.parse(job.payload);
  const renderConfigId = format?.renderConfigId;
  const variant = format ? format.variant ?? RenderedClipVariant.VERTICAL_SHORT_FORM : RenderedClipVariant.TRIMMED_ORIGINAL;
  const layout = format?.layout ?? RenderedClipLayout.DEFAULT;
  const mode = await classifyShortFormGenerationMode({
    contentPackId: payload.contentPackId!, generationRunId: payload.generationRunId,
  }, tx);
  if (mode.kind === 'invalid_snapshot_reference') throw new Error(mode.code);
  const [candidate] = await tx.select().from(clipCandidates)
    .where(eq(clipCandidates.id, payload.clipCandidateId)).limit(1);
  if (!candidate || candidate.userId !== payload.userId ||
    candidate.sourceAssetId !== payload.sourceAssetId ||
    candidate.contentPackId !== payload.contentPackId ||
    candidate.generationRunId !== payload.generationRunId ||
    (mode.kind === 'snapshot' && (!renderConfigId || candidate.currentRenderConfigId !== renderConfigId))) {
    throw new Error('render_result_authority_mismatch');
  }
  const [clip] = await tx.select().from(renderedClips).where(and(
    eq(renderedClips.clipCandidateId, candidate.id),
    eq(renderedClips.userId, payload.userId),
    eq(renderedClips.sourceAssetId, payload.sourceAssetId),
    eq(renderedClips.contentPackId, candidate.contentPackId),
    eq(renderedClips.generationRunId, payload.generationRunId),
    eq(renderedClips.variant, variant), eq(renderedClips.layout, layout),
    renderConfigId ? eq(renderedClips.clipRenderConfigId, renderConfigId) : isNull(renderedClips.clipRenderConfigId),
    format?.editConfigHash
      ? eq(renderedClips.editConfigHash, format.editConfigHash) : undefined,
    format?.editConfigId
      ? eq(renderedClips.editConfigId, format.editConfigId) : undefined,
    result && 'renderedClipId' in result ? eq(renderedClips.id, result.renderedClipId) : undefined,
    isNull(renderedClips.deletedAt), isNull(renderedClips.storageDeletedAt)
  )).for('update').limit(1);
  if (!clip || clip.status !== RenderedClipStatus.READY || !clip.storageKey || !clip.storageUrl) {
    throw new Error('render_result_not_ready');
  }
  if (result && (result.jobType !== job.type || !('renderedClipId' in result) ||
    result.sourceAssetId !== clip.sourceAssetId || result.contentPackId !== clip.contentPackId ||
    result.clipCandidateId !== clip.clipCandidateId || result.variant !== clip.variant || result.layout !== clip.layout)) {
    throw new Error('render_result_identity_mismatch');
  }
  return {
    jobType: job.type as JobType.RENDER_CLIP_CANDIDATE | JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
    sourceAssetId: clip.sourceAssetId, contentPackId: clip.contentPackId,
    clipCandidateId: clip.clipCandidateId, renderedClipId: clip.id,
    variant: clip.variant as RenderedClipVariant, layout: clip.layout as RenderedClipLayout,
    persistedAt: clip.updatedAt,
  };
}
