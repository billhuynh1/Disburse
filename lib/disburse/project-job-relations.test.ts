import assert from 'node:assert/strict';
import test from 'node:test';
import { getRelatedProjectJobIds } from './project-job-relations.ts';

test('matches jobs by project, source asset, content pack, and clip candidate ids', () => {
  const relatedJobs = getRelatedProjectJobIds({
    jobs: [
      { id: 1, status: 'pending', payload: { projectId: 12 } },
      { id: 2, status: 'processing', payload: { sourceAssetId: 22 } },
      { id: 3, status: 'completed', payload: { contentPackId: 32 } },
      { id: 4, status: 'pending', payload: { clipCandidateId: 42 } },
      { id: 5, status: 'pending', payload: { projectId: 999 } },
    ],
    projectId: 12,
    sourceAssetIds: [22],
    contentPackIds: [32],
    clipCandidateIds: [42],
  });

  assert.deepEqual(relatedJobs, [
    { id: 1, status: 'pending' },
    { id: 2, status: 'processing' },
    { id: 3, status: 'completed' },
    { id: 4, status: 'pending' },
  ]);
});

test('ignores jobs with missing, malformed, or stringified payload ids', () => {
  const relatedJobs = getRelatedProjectJobIds({
    jobs: [
      { id: 1, status: 'pending', payload: null },
      { id: 2, status: 'pending', payload: 'bad-payload' },
      { id: 3, status: 'pending', payload: { sourceAssetId: '22' } },
      { id: 4, status: 'pending', payload: { contentPackId: '32' } },
      { id: 5, status: 'pending', payload: { clipCandidateId: '42' } },
      { id: 6, status: 'pending', payload: { projectId: '12' } },
    ],
    projectId: 12,
    sourceAssetIds: [22],
    contentPackIds: [32],
    clipCandidateIds: [42],
  });

  assert.deepEqual(relatedJobs, []);
});

test('discovers related work for all eight job types including publication relationships', () => {
  const relatedJobs = getRelatedProjectJobIds({
    jobs: [
      { id: 1, status: 'pending', payload: { sourceAssetId: 22 } },
      { id: 2, status: 'pending', payload: { sourceAssetId: 22 } },
      { id: 3, status: 'pending', payload: { sourceAssetId: 22 } },
      { id: 4, status: 'pending', payload: { contentPackId: 32, sourceAssetId: 22 } },
      { id: 5, status: 'pending', payload: { clipCandidateId: 42, sourceAssetId: 22 } },
      { id: 6, status: 'pending', payload: { clipCandidateId: 42, sourceAssetId: 22 } },
      { id: 7, status: 'pending', payload: { clipCandidateId: 42, sourceAssetId: 22 } },
      { id: 8, status: 'pending', payload: { renderedClipId: 52, clipPublicationId: 62 } },
    ],
    projectId: 12,
    sourceAssetIds: [22],
    contentPackIds: [32],
    clipCandidateIds: [42],
    renderedClipIds: [52],
    clipPublicationIds: [62],
  });

  assert.deepEqual(relatedJobs.map((job) => job.id), [1, 2, 3, 4, 5, 6, 7, 8]);
});
