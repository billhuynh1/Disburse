import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

test('deletion uses intent, cancellation, lease, storage, then graph finalization barriers', async () => {
  const [media, jobs, actions] = await Promise.all([
    read('./media-retention-service.ts'),
    read('./job-service.ts'),
    read('./actions.ts'),
  ]);

  assert.match(media, /const ALL_JOB_TYPES = Object\.values\(JobType\)/);
  assert.match(media, /renderedClipIds/);
  assert.match(media, /clipPublicationIds/);
  assert.match(media, /sourceAssetThumbnailVariants/);
  assert.match(media, /cancellationRequestedAt: now/);
  assert.match(media, /hasActiveDeletionLease/);
  assert.match(media, /await Promise\.all\(readiness\.graph\.storageKeys\.map\(removeStorageObject\)\)/);
  assert.match(media, /getDeterministicSourceAssetThumbnailStorageKeys/);
  assert.match(media, /isNotNull\(projects\.deletionRequestedAt\)/);
  assert.match(media, /isNotNull\(sourceAssets\.deletionRequestedAt\)/);
  assert.doesNotMatch(media, /blockProcessingJobs/);
  assert.doesNotMatch(actions, /blockProcessingJobs/);

  assert.match(jobs, /withJobEnqueueBarrier/);
  assert.match(jobs, /isNull\(jobs\.cancellationRequestedAt\)/);
  assert.match(jobs, /acknowledgeJobCancellation/);
  assert.match(jobs, /cancellationReason: String\(reason\)/);
});

test('upload completion and the missing-candidate path retain lifecycle fences', async () => {
  const [uploads, authorization] = await Promise.all([
    read('./source-asset-upload-service.ts'),
    read('./job-execution-authorization.ts'),
  ]);

  assert.match(uploads, /project\.deletionRequestedAt/);
  assert.match(uploads, /\.for\('update'\)/);
  assert.match(uploads, /Upload completion cannot create media under a deleting project/);
  assert.match(authorization, /authorizeMissingCandidateCancellation/);
  assert.match(authorization, /await assertLifecycle\(tx, \{/);
});
