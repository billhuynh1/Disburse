import { JobType } from '../db/schema.ts';
import { parseJobPayloadForType } from './job-payload-schema.ts';

export type ProjectJobRelationParams = {
  jobs: Array<{ id: number; type: string; status: string; payload: unknown }>;
  projectId: number;
  sourceAssetIds: number[];
  contentPackIds: number[];
  clipCandidateIds: number[];
  renderedClipIds?: number[];
  clipPublicationIds?: number[];
};

export function getRelatedProjectJobIds(params: ProjectJobRelationParams) {
  return params.jobs
    .filter((job) => {
      const payload = parseJobPayloadForType(job.type, job.payload);
      if (!payload) return false;

      switch (job.type) {
        case JobType.TRANSCRIBE_SOURCE_ASSET:
        case JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL:
        case JobType.INGEST_YOUTUBE_SOURCE_ASSET:
          return 'sourceAssetId' in payload &&
            params.sourceAssetIds.includes(payload.sourceAssetId);
        case JobType.GENERATE_SHORT_FORM_PACK:
          return (
            ('sourceAssetId' in payload &&
              typeof payload.sourceAssetId === 'number' &&
              params.sourceAssetIds.includes(payload.sourceAssetId)) ||
            ('contentPackId' in payload &&
              typeof payload.contentPackId === 'number' &&
              params.contentPackIds.includes(payload.contentPackId))
          );
        case JobType.RENDER_CLIP_CANDIDATE:
        case JobType.FORMAT_RENDERED_CLIP_SHORT_FORM:
        case JobType.DETECT_CLIP_FACECAM:
          return (
            ('sourceAssetId' in payload &&
              params.sourceAssetIds.includes(payload.sourceAssetId)) ||
            ('contentPackId' in payload &&
              typeof payload.contentPackId === 'number' &&
              params.contentPackIds.includes(payload.contentPackId)) ||
            ('clipCandidateId' in payload &&
              typeof payload.clipCandidateId === 'number' &&
              params.clipCandidateIds.includes(payload.clipCandidateId))
          );
        case JobType.PUBLISH_RENDERED_CLIP:
          return (
            ('renderedClipId' in payload &&
              (params.renderedClipIds ?? []).includes(payload.renderedClipId)) ||
            ('clipPublicationId' in payload &&
              (params.clipPublicationIds ?? []).includes(payload.clipPublicationId))
          );
        default:
          return false;
      }
    })
    .map((job) => ({ id: job.id, status: job.status }));
}
