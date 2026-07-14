import assert from 'node:assert/strict';
import test from 'node:test';
import { JobStatus, JobType, RenderedClipLayout, RenderedClipVariant } from '../db/schema.ts';
import { classifyFormatRenderJob } from './render-job-compatibility.ts';

const expected = {
  clipCandidateId: 1,
  contentPackId: 2,
  sourceAssetId: 3,
  userId: 4,
  generationRunId: 'run',
  variant: RenderedClipVariant.VERTICAL_SHORT_FORM,
  layout: RenderedClipLayout.DEFAULT,
  editConfigHash: 'hash',
  editConfigId: 5,
};
const legacyPayload = {
  clipCandidateId: 1,
  contentPackId: 2,
  sourceAssetId: 3,
  userId: 4,
  generationRunId: 'run',
  variant: RenderedClipVariant.VERTICAL_SHORT_FORM,
  layout: RenderedClipLayout.DEFAULT,
  editConfigHash: 'hash',
};

test('active matching legacy renders block rollout duplicates but terminal jobs do not', () => {
  for (const status of [JobStatus.PENDING, JobStatus.PROCESSING]) {
    assert.equal(classifyFormatRenderJob({
      type: JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
      status,
      payload: legacyPayload,
    }, expected), 'legacy_active_blocker');
  }
  assert.equal(classifyFormatRenderJob({
    type: JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
    status: JobStatus.COMPLETED,
    payload: legacyPayload,
  }, expected), 'legacy_terminal');
});

test('legacy rollout blockers require the complete coarse identity', () => {
  for (const changed of [
    { generationRunId: 'other' },
    { variant: RenderedClipVariant.TRIMMED_ORIGINAL },
    { layout: RenderedClipLayout.FACECAM_TOP_40 },
    { editConfigHash: 'other' },
  ]) {
    assert.equal(classifyFormatRenderJob({
      type: JobType.FORMAT_RENDERED_CLIP_SHORT_FORM,
      status: JobStatus.PENDING,
      payload: { ...legacyPayload, ...changed },
    }, expected), 'unrelated');
  }
});
