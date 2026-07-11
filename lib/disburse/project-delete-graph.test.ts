import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readRepoFile(path: string) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('project deletion removes render configs before facecam detections', () => {
  const service = readRepoFile('lib/disburse/media-retention-service.ts');

  assert.match(service, /clipRenderConfigs/);
  assert.match(
    service,
    /delete\(clipRenderConfigs\)[\s\S]*delete\(clipCandidateFacecamDetections\)/
  );
});

test('project deletion removes upload sessions before source assets', () => {
  const service = readRepoFile('lib/disburse/media-retention-service.ts');

  assert.match(service, /sourceUploadParts/);
  assert.match(service, /sourceUploadSessions/);
  assert.match(
    service,
    /delete\(sourceUploadParts\)[\s\S]*delete\(sourceUploadSessions\)[\s\S]*delete\(sourceAssets\)/
  );
});

test('project deletion removes thumbnail variants before source assets', () => {
  const service = readRepoFile('lib/disburse/media-retention-service.ts');

  assert.match(service, /thumbnailVariants: true/);
  assert.match(service, /sourceAssetThumbnailVariants/);
  assert.match(
    service,
    /delete\(sourceAssetThumbnailVariants\)[\s\S]*delete\(sourceAssets\)/
  );
});

test('project delete action logs raw errors but returns generic copy', () => {
  const actions = readRepoFile('lib/disburse/actions.ts');
  const deleteProjectAction = actions.slice(
    actions.indexOf('const deleteProjectSchema'),
    actions.indexOf('function buildShortFormSetupInstructions')
  );

  assert.match(deleteProjectAction, /console\.error\('Project deletion failed'/);
  assert.match(deleteProjectAction, /error: 'Project could not be deleted\.'/);
  assert.doesNotMatch(
    deleteProjectAction,
    /error:\s*error instanceof Error\s*\?\s*error\.message/
  );
});
