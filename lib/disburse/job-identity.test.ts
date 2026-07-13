import assert from 'node:assert/strict';
import test from 'node:test';
import { JobType } from '../db/schema.ts';
import { buildJobIdempotencyKey } from './job-identity.ts';

test('builds stable identities for every non-facecam job type', () => {
  const cases = [
    [JobType.TRANSCRIBE_SOURCE_ASSET, { sourceAssetId: 1, userId: 2 }, 'transcribe_source_asset:source:1:v1'],
    [JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL, { sourceAssetId: 1, userId: 2 }, 'source-asset-thumbnail:1'],
    [JobType.INGEST_YOUTUBE_SOURCE_ASSET, { sourceAssetId: 1, userId: 2 }, 'ingest_youtube_source_asset:source:1:v1'],
    [JobType.GENERATE_SHORT_FORM_PACK, { contentPackId: 3, sourceAssetId: 1, userId: 2, generationRunId: 'run' }, 'generate-short-form:pack:3:run:run'],
    [JobType.RENDER_CLIP_CANDIDATE, { clipCandidateId: 4, contentPackId: 3, sourceAssetId: 1, userId: 2, generationRunId: 'run' }, 'render_clip_candidate:candidate:4:run:run:variant:trimmed_original:layout:default:config:default'],
    [JobType.FORMAT_RENDERED_CLIP_SHORT_FORM, { clipCandidateId: 4, contentPackId: 3, sourceAssetId: 1, userId: 2, generationRunId: 'run' }, 'format_rendered_clip_short_form:candidate:4:run:run:variant:vertical_short_form:layout:default:config:default'],
    [JobType.PUBLISH_RENDERED_CLIP, { clipPublicationId: 5, renderedClipId: 6, linkedAccountId: 7, userId: 2, platform: 'youtube' }, 'publish:publication:5:rendered:6'],
  ] as const;

  for (const [type, payload, expected] of cases) {
    assert.equal(buildJobIdempotencyKey(type, payload), expected);
  }
});

test('requires detector-specific identity construction for facecam jobs', () => {
  assert.throws(() => buildJobIdempotencyKey(JobType.DETECT_CLIP_FACECAM, {} as never));
});
