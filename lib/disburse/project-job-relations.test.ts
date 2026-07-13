import assert from 'node:assert/strict';
import test from 'node:test';
import { JobType } from '../db/schema.ts';
import { getRelatedProjectJobIds } from './project-job-relations.ts';

const relation = {
  projectId: 12,
  sourceAssetIds: [22],
  contentPackIds: [32],
  clipCandidateIds: [42],
  renderedClipIds: [52],
  clipPublicationIds: [62],
};

test('discovers canonical relationships for all eight job types', () => {
  const jobs = [
    { type: JobType.TRANSCRIBE_SOURCE_ASSET, payload: { sourceAssetId: 22, userId: 1 } },
    { type: JobType.EXTRACT_SOURCE_ASSET_THUMBNAIL, payload: { sourceAssetId: 22, userId: 1 } },
    { type: JobType.INGEST_YOUTUBE_SOURCE_ASSET, payload: { sourceAssetId: 22, userId: 1 } },
    { type: JobType.GENERATE_SHORT_FORM_PACK, payload: { sourceAssetId: 22, contentPackId: 32, userId: 1, generationRunId: 'run' } },
    { type: JobType.RENDER_CLIP_CANDIDATE, payload: { sourceAssetId: 22, contentPackId: 32, clipCandidateId: 42, userId: 1, generationRunId: 'run' } },
    { type: JobType.FORMAT_RENDERED_CLIP_SHORT_FORM, payload: { sourceAssetId: 22, contentPackId: 32, clipCandidateId: 42, userId: 1, generationRunId: 'run' } },
    { type: JobType.DETECT_CLIP_FACECAM, payload: { sourceAssetId: 22, contentPackId: 32, clipCandidateId: 42, userId: 1, generationRunId: 'run', startTimeMs: 0, endTimeMs: 1, detectorVersion: 'v1', detectionRunId: 1 } },
    { type: JobType.PUBLISH_RENDERED_CLIP, payload: { clipPublicationId: 62, renderedClipId: 52, linkedAccountId: 1, userId: 1, platform: 'youtube' } },
  ].map((job, index) => ({ id: index + 1, status: 'pending', ...job }));

  assert.deepEqual(
    getRelatedProjectJobIds({ jobs, ...relation }).map((job) => job.id),
    [1, 2, 3, 4, 5, 6, 7, 8]
  );
});

test('ignores malformed payloads with coincidental relationship ids', () => {
  const jobs = [
    { id: 1, type: JobType.TRANSCRIBE_SOURCE_ASSET, status: 'pending', payload: { sourceAssetId: 22 } },
    { id: 2, type: JobType.GENERATE_SHORT_FORM_PACK, status: 'pending', payload: { sourceAssetId: 22, contentPackId: '32', userId: 1 } },
    { id: 3, type: 'unknown', status: 'pending', payload: { sourceAssetId: 22, userId: 1 } },
  ];

  assert.deepEqual(getRelatedProjectJobIds({ jobs, ...relation }), []);
});

test('publish relatedness ignores an extraneous matching source asset id', () => {
  const jobs = [{
    id: 1,
    type: JobType.PUBLISH_RENDERED_CLIP,
    status: 'pending',
    payload: {
      clipPublicationId: 999,
      renderedClipId: 998,
      linkedAccountId: 1,
      userId: 1,
      platform: 'youtube',
      sourceAssetId: 22,
    },
  }];

  assert.deepEqual(getRelatedProjectJobIds({ jobs, ...relation }), []);
});

test('missing-candidate work remains related through validated source and pack fields', () => {
  const jobs = [{
    id: 1,
    type: JobType.RENDER_CLIP_CANDIDATE,
    status: 'processing',
    payload: {
      sourceAssetId: 22,
      contentPackId: 32,
      clipCandidateId: 999,
      userId: 1,
      generationRunId: 'run',
    },
  }];

  assert.deepEqual(getRelatedProjectJobIds({ jobs, ...relation }), [
    { id: 1, status: 'processing' },
  ]);
});
