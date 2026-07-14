import { JobStatus, JobType, RenderedClipLayout, RenderedClipVariant } from '../db/schema.ts';
import { formatRenderedClipShortFormJobPayloadSchema } from './job-payload-schema.ts';

export type ExpectedFormatRenderIdentity = {
  clipCandidateId: number;
  contentPackId: number;
  sourceAssetId: number;
  userId: number;
  generationRunId: string;
  variant: RenderedClipVariant;
  layout: RenderedClipLayout;
  editConfigHash?: string;
  renderConfigId?: number;
  editConfigId?: number;
};

type RenderJob = {
  type: string;
  status: string;
  payload: unknown;
};

export function classifyFormatRenderJob(
  job: RenderJob,
  expected: ExpectedFormatRenderIdentity
) {
  if (job.type !== JobType.FORMAT_RENDERED_CLIP_SHORT_FORM) return 'unrelated' as const;
  const parsed = formatRenderedClipShortFormJobPayloadSchema.safeParse(job.payload);
  if (!parsed.success) return 'unrelated' as const;
  const payload = parsed.data;
  if (
    payload.clipCandidateId !== expected.clipCandidateId ||
    payload.contentPackId !== expected.contentPackId ||
    payload.sourceAssetId !== expected.sourceAssetId ||
    payload.userId !== expected.userId ||
    payload.generationRunId !== expected.generationRunId ||
    (payload.variant ?? RenderedClipVariant.VERTICAL_SHORT_FORM) !== expected.variant ||
    (payload.layout ?? RenderedClipLayout.DEFAULT) !== expected.layout ||
    payload.editConfigHash !== expected.editConfigHash
  ) return 'unrelated' as const;

  if (
    payload.renderConfigId === expected.renderConfigId &&
    payload.editConfigId === expected.editConfigId
  ) return 'exact' as const;

  if (payload.renderConfigId === undefined && payload.editConfigId === undefined) {
    return [JobStatus.PENDING, JobStatus.PROCESSING].includes(job.status as JobStatus)
      ? 'legacy_active_blocker' as const
      : 'legacy_terminal' as const;
  }
  return 'unrelated' as const;
}
