import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRenderedClipStorageKey } from './s3-storage.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readRepoFile(path: string) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('render start is an atomic pending-to-rendering acquire', () => {
  const service = readRepoFile('lib/disburse/rendered-clip-service.ts');

  assert.match(service, /function acquireRenderedClipForRendering/);
  assert.match(service, /eq\(renderedClips\.status,\s*RenderedClipStatus\.PENDING\)/);
  assert.match(service, /returning\(\)/);
  assert.match(service, /render_started\.reuse_active/);
});

test('render identity includes candidate, variant, layout, and config hash', () => {
  const schema = readRepoFile('lib/db/schema.ts');
  const jobs = readRepoFile('lib/disburse/job-service.ts');

  assert.match(schema, /rendered_clips_candidate_variant_layout_config_idx/);
  assert.match(schema, /table\.clipCandidateId,\s*table\.variant,\s*table\.layout,\s*table\.editConfigHash/s);
  assert.match(jobs, /payload->>'clipCandidateId'/);
  assert.match(jobs, /payload->>'editConfigHash'/);
});

test('rendered storage keys are immutable per render config and stable for retries', () => {
  const keyForConfigA = createRenderedClipStorageKey(
    7,
    11,
    13,
    'vertical_short_form',
    'default',
    17
  );
  const retryKeyForConfigA = createRenderedClipStorageKey(
    7,
    11,
    13,
    'vertical_short_form',
    'default',
    17
  );
  const keyForConfigB = createRenderedClipStorageKey(
    7,
    11,
    13,
    'vertical_short_form',
    'default',
    19
  );
  const siblingFacecamKey = createRenderedClipStorageKey(
    7,
    11,
    13,
    'vertical_short_form',
    'facecam_split',
    23
  );

  assert.equal(retryKeyForConfigA, keyForConfigA);
  assert.notEqual(keyForConfigA, keyForConfigB);
  assert.notEqual(keyForConfigA, siblingFacecamKey);
  assert.match(keyForConfigA, /render-config-17\.mp4$/);
});

test('final publication locks and revalidates the authoritative render config', () => {
  const service = readRepoFile('lib/disburse/rendered-clip-service.ts');
  assert.match(service, /from\(clipRenderConfigs\)[\s\S]*?for\('update'\)/);
  assert.match(service, /from\(clipCandidates\)[\s\S]*?for\('update'\)/);
  assert.match(service, /from\(contentPacks\)[\s\S]*?for\('update'\)/);
  assert.match(service, /from\(renderedClips\)[\s\S]*?for\('update'\)/);
  assert.match(service, /lockedRenderConfig\.configHash === renderConfig\.configHash/);
  assert.match(service, /lockedCandidate\.currentRenderConfigId === lockedRenderConfig\?\.id/);
  assert.match(service, /isRenderConfigInCurrentExpectedSet\([\s\S]*?\{ lock: true \}/);
});
