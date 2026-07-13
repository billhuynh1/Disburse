import {
  JobType,
  RenderedClipLayout,
  RenderedClipVariant,
  type FormatRenderedClipShortFormJobPayload,
  type GenerateShortFormPackJobPayload,
  type IngestYoutubeSourceAssetJobPayload,
  type JobPayload,
  type PublishRenderedClipJobPayload,
  type RenderClipCandidateJobPayload,
  type TranscribeSourceAssetJobPayload,
} from '../db/schema.ts';

export function buildJobIdempotencyKey(type: JobType, payload: JobPayload) {
  switch (type) {
    case JobType.TRANSCRIBE_SOURCE_ASSET:
      return `transcribe_source_asset:source:${(payload as TranscribeSourceAssetJobPayload).sourceAssetId}:v1`;
    case JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL:
      return `source-asset-thumbnail:${(payload as { sourceAssetId: number }).sourceAssetId}`;
    case JobType.INGEST_YOUTUBE_SOURCE_ASSET:
      return `ingest_youtube_source_asset:source:${(payload as IngestYoutubeSourceAssetJobPayload).sourceAssetId}:v1`;
    case JobType.GENERATE_SHORT_FORM_PACK: {
      const value = payload as GenerateShortFormPackJobPayload;
      return `generate-short-form:pack:${value.contentPackId}:run:${value.generationRunId}`;
    }
    case JobType.RENDER_CLIP_CANDIDATE: {
      const value = payload as RenderClipCandidateJobPayload;
      return `render_clip_candidate:candidate:${value.clipCandidateId}:run:${value.generationRunId}:variant:trimmed_original:layout:default:config:default`;
    }
    case JobType.FORMAT_RENDERED_CLIP_SHORT_FORM: {
      const value = payload as FormatRenderedClipShortFormJobPayload;
      return `format_rendered_clip_short_form:candidate:${value.clipCandidateId}:run:${value.generationRunId}:variant:${value.variant ?? RenderedClipVariant.VERTICAL_SHORT_FORM}:layout:${value.layout ?? RenderedClipLayout.DEFAULT}:config:${value.editConfigHash ?? 'default'}`;
    }
    case JobType.PUBLISH_RENDERED_CLIP: {
      const value = payload as PublishRenderedClipJobPayload;
      return `publish:publication:${value.clipPublicationId}:rendered:${value.renderedClipId}`;
    }
    case JobType.DETECT_CLIP_FACECAM:
      throw new Error('Facecam identities require detector-specific inputs.');
  }
}
