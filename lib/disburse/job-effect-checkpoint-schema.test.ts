import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FacecamDetectionStatus,
  JobType,
  RenderedClipLayout,
  RenderedClipVariant,
} from '../db/schema.ts';
import { parseJobEffectCheckpointResult } from './job-effect-checkpoint-schema.ts';

test('checkpoint schemas preserve typed dates, nullable identities, enums, and zero detections', () => {
  const persistedAt = new Date().toISOString();
  const facecam = parseJobEffectCheckpointResult(JobType.DETECT_CLIP_FACECAM, {
    jobType: JobType.DETECT_CLIP_FACECAM,
    sourceAssetId: 1,
    contentPackId: 2,
    clipCandidateId: 3,
    videoId: null,
    detectionRunId: 4,
    generationRunId: 'generation-1',
    status: FacecamDetectionStatus.NOT_FOUND,
    detectionCount: 0,
    persistedAt,
  });
  assert.ok(facecam);
  assert.equal(facecam.detectionCount, 0);
  assert.equal(facecam.videoId, null);
  assert.ok(facecam.persistedAt instanceof Date);

  const render = parseJobEffectCheckpointResult(JobType.RENDER_CLIP_CANDIDATE, {
    jobType: JobType.RENDER_CLIP_CANDIDATE,
    sourceAssetId: 1,
    contentPackId: 2,
    clipCandidateId: 3,
    renderedClipId: 5,
    variant: RenderedClipVariant.TRIMMED_ORIGINAL,
    layout: RenderedClipLayout.DEFAULT,
    persistedAt,
  });
  assert.equal(render?.renderedClipId, 5);
});

test('checkpoint schemas reject publishing and invalid facecam statuses', () => {
  assert.equal(parseJobEffectCheckpointResult(JobType.PUBLISH_RENDERED_CLIP, {}), null);
  assert.equal(parseJobEffectCheckpointResult(JobType.DETECT_CLIP_FACECAM, {
    jobType: JobType.DETECT_CLIP_FACECAM,
    sourceAssetId: 1,
    contentPackId: null,
    clipCandidateId: null,
    videoId: 1,
    detectionRunId: null,
    generationRunId: null,
    status: 'invented',
    detectionCount: 0,
    persistedAt: new Date().toISOString(),
  }), null);
});
