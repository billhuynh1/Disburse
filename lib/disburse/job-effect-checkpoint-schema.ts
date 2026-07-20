import { z } from 'zod';

import {
  FacecamDetectionStatus,
  JobType,
  RenderedClipLayout,
  RenderedClipVariant,
} from '@/lib/db/schema';

const base = z.object({
  jobType: z.nativeEnum(JobType),
  sourceAssetId: z.number().int().positive(),
  persistedAt: z.coerce.date(),
});

export const jobEffectCheckpointResultSchemas = {
  [JobType.TRANSCRIBE_SOURCE_ASSET]: base.extend({
    jobType: z.literal(JobType.TRANSCRIBE_SOURCE_ASSET),
    transcriptId: z.number().int().positive(),
  }),
  [JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL]: base.extend({
    jobType: z.literal(JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL),
    thumbnailVariantId: z.number().int().positive().nullable(),
  }),
  [JobType.INGEST_YOUTUBE_SOURCE_ASSET]: base.extend({
    jobType: z.literal(JobType.INGEST_YOUTUBE_SOURCE_ASSET),
    transcriptId: z.number().int().positive(),
  }),
  [JobType.GENERATE_SHORT_FORM_PACK]: base.extend({
    jobType: z.literal(JobType.GENERATE_SHORT_FORM_PACK),
    contentPackId: z.number().int().positive(),
    generationRunId: z.string().trim().min(1),
  }),
  [JobType.RENDER_CLIP_CANDIDATE]: base.extend({
    jobType: z.literal(JobType.RENDER_CLIP_CANDIDATE),
    contentPackId: z.number().int().positive(),
    clipCandidateId: z.number().int().positive(),
    renderedClipId: z.number().int().positive(),
    variant: z.nativeEnum(RenderedClipVariant),
    layout: z.nativeEnum(RenderedClipLayout),
  }),
  [JobType.FORMAT_RENDERED_CLIP_SHORT_FORM]: base.extend({
    jobType: z.literal(JobType.FORMAT_RENDERED_CLIP_SHORT_FORM),
    contentPackId: z.number().int().positive(),
    clipCandidateId: z.number().int().positive(),
    renderedClipId: z.number().int().positive(),
    variant: z.nativeEnum(RenderedClipVariant),
    layout: z.nativeEnum(RenderedClipLayout),
  }),
  [JobType.DETECT_CLIP_FACECAM]: base.extend({
    jobType: z.literal(JobType.DETECT_CLIP_FACECAM),
    contentPackId: z.number().int().positive().nullable(),
    clipCandidateId: z.number().int().positive().nullable(),
    videoId: z.number().int().positive().nullable(),
    detectionRunId: z.number().int().positive().nullable(),
    generationRunId: z.string().trim().min(1).nullable(),
    status: z.nativeEnum(FacecamDetectionStatus),
    detectionCount: z.number().int().nonnegative(),
  }),
  [JobType.PUBLISH_RENDERED_CLIP]: z.never(),
} satisfies Record<JobType, z.ZodTypeAny>;

export type CheckpointedJobType = Exclude<JobType, JobType.PUBLISH_RENDERED_CLIP>;
export type JobEffectCheckpointResultByType = {
  [Type in CheckpointedJobType]: z.infer<(typeof jobEffectCheckpointResultSchemas)[Type]>;
};
export type JobEffectCheckpointResult = JobEffectCheckpointResultByType[CheckpointedJobType];

export function parseJobEffectCheckpointResult<Type extends CheckpointedJobType>(
  type: Type,
  value: unknown
): JobEffectCheckpointResultByType[Type] | null;
export function parseJobEffectCheckpointResult(
  type: JobType.PUBLISH_RENDERED_CLIP,
  value: unknown
): null;
export function parseJobEffectCheckpointResult(
  type: JobType,
  value: unknown
): JobEffectCheckpointResult | null;
export function parseJobEffectCheckpointResult(type: JobType, value: unknown) {
  if (type === JobType.PUBLISH_RENDERED_CLIP) return null;
  const parsed = jobEffectCheckpointResultSchemas[type].safeParse(value);
  return parsed.success ? (parsed.data as JobEffectCheckpointResult) : null;
}
