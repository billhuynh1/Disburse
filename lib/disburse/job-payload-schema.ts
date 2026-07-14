import { z } from 'zod';
import {
  JobType,
  RenderedClipLayout,
  RenderedClipVariant,
  type JobPayload,
} from '../db/schema.ts';

export const sourceAssetJobPayloadSchema = z.object({
  sourceAssetId: z.number().int().positive(),
  userId: z.number().int().positive(),
});

export const transcribeSourceAssetJobPayloadSchema = sourceAssetJobPayloadSchema;
export const extractSourceAssetThumbnailJobPayloadSchema = sourceAssetJobPayloadSchema;
export const ingestYoutubeSourceAssetJobPayloadSchema = sourceAssetJobPayloadSchema;

export const generateShortFormPackJobPayloadSchema = sourceAssetJobPayloadSchema.extend({
  contentPackId: z.number().int().positive(),
  generationRunId: z.string().trim().min(1),
  transcriptId: z.number().int().positive().optional(),
  brandTemplateId: z.number().int().positive().optional(),
  reconciliationRebuild: z.object({
    originalGenerationRunId: z.string().trim().min(1),
    reason: z.literal('clip_candidate_missing'),
  }).optional(),
});

export const renderClipCandidateJobPayloadSchema = sourceAssetJobPayloadSchema.extend({
  contentPackId: z.number().int().positive(),
  generationRunId: z.string().trim().min(1),
  clipCandidateId: z.number().int().positive(),
  captionsEnabled: z.boolean().optional(),
  captionFontAssetId: z.number().int().positive().optional(),
});

export const formatRenderedClipShortFormJobPayloadSchema =
  renderClipCandidateJobPayloadSchema.extend({
    renderConfigId: z.number().int().positive().optional(),
    editConfigId: z.number().int().positive().optional(),
    variant: z.nativeEnum(RenderedClipVariant).optional(),
    layout: z.nativeEnum(RenderedClipLayout).optional(),
    editConfigHash: z.string().min(1).optional(),
  });

export const legacyDetectClipFacecamJobPayloadSchema =
  sourceAssetJobPayloadSchema.extend({
    videoId: z.number().int().positive(),
    contentPackId: z.number().int().positive().optional(),
    generationRunId: z.string().trim().min(1).optional(),
  });

export const candidateDetectClipFacecamJobPayloadSchema =
  sourceAssetJobPayloadSchema.extend({
    contentPackId: z.number().int().positive(),
    generationRunId: z.string().trim().min(1),
    clipCandidateId: z.number().int().positive(),
    startTimeMs: z.number().int().nonnegative(),
    endTimeMs: z.number().int().positive(),
    detectorVersion: z.string().trim().min(1),
    detectionRunId: z.number().int().positive(),
  });

export const detectClipFacecamJobPayloadSchema = z.union([
  candidateDetectClipFacecamJobPayloadSchema,
  legacyDetectClipFacecamJobPayloadSchema,
]);

export const publishRenderedClipJobPayloadSchema = z.object({
  clipPublicationId: z.number().int().positive(),
  renderedClipId: z.number().int().positive(),
  linkedAccountId: z.number().int().positive(),
  userId: z.number().int().positive(),
  platform: z.enum(['youtube', 'tiktok']),
});

export const jobPayloadSchemas = {
  [JobType.TRANSCRIBE_SOURCE_ASSET]: transcribeSourceAssetJobPayloadSchema,
  [JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL]: extractSourceAssetThumbnailJobPayloadSchema,
  [JobType.INGEST_YOUTUBE_SOURCE_ASSET]: ingestYoutubeSourceAssetJobPayloadSchema,
  [JobType.GENERATE_SHORT_FORM_PACK]: generateShortFormPackJobPayloadSchema,
  [JobType.RENDER_CLIP_CANDIDATE]: renderClipCandidateJobPayloadSchema,
  [JobType.FORMAT_RENDERED_CLIP_SHORT_FORM]: formatRenderedClipShortFormJobPayloadSchema,
  [JobType.DETECT_CLIP_FACECAM]: detectClipFacecamJobPayloadSchema,
  [JobType.PUBLISH_RENDERED_CLIP]: publishRenderedClipJobPayloadSchema,
} satisfies Record<JobType, z.ZodTypeAny>;

export function parseJobPayloadForType(type: unknown, payload: unknown) {
  if (!Object.values(JobType).includes(type as JobType)) return null;
  const parsed = jobPayloadSchemas[type as JobType].safeParse(payload);
  return parsed.success ? parsed.data as JobPayload : null;
}
