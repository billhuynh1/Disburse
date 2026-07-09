import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readRepoFile(path: string) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('selected template render configs multiply enabled aspect ratios and layouts', () => {
  const brandTemplateService = readRepoFile(
    'lib/disburse/brand-template-service.ts'
  );

  assert.match(brandTemplateService, /export async function createRenderConfigsForTemplate/);
  assert.match(
    brandTemplateService,
    /params\.template\.enabledAspectRatios\?\.length > 0[\s\S]*params\.template\.enabledLayouts\?\.length > 0/
  );
  assert.match(
    brandTemplateService,
    /for \(const aspectRatio of aspectRatios as ClipEditAspectRatio\[\]\) \{[\s\S]*for \(const layout of layouts as RenderedClipLayout\[\]\)/
  );
  assert.match(brandTemplateService, /clipRenderConfigs/);
  assert.match(brandTemplateService, /configHash/);
});

test('short-form generation creates render configs after default edit configs', () => {
  const shortFormService = readRepoFile('lib/disburse/short-form-service.ts');

  assert.match(shortFormService, /ensureDefaultClipEditConfigs\(/);
  assert.match(shortFormService, /createRenderConfigsForEditConfigs\(/);
  assert.match(shortFormService, /createRenderableRenderConfigsForEditConfig/);
  assert.match(shortFormService, /renderConfigs,/);
});

test('completed uploaded-video facecam detection queues one format job per render config', () => {
  const pipeline = readRepoFile('lib/disburse/pipeline-service.ts');

  assert.match(pipeline, /enqueueFormatJobsForClipRenderConfigs/);
  assert.match(pipeline, /createRenderableRenderConfigsForEditConfig/);
  assert.doesNotMatch(pipeline, /db\.query\.clipRenderConfigs\.findMany/);
  assert.match(pipeline, /renderConfig\.configHash/);
  assert.match(pipeline, /renderConfig\.id/);
  assert.match(pipeline, /queuedRenderConfigCount === 0/);
});

test('render job reuse remains scoped to active or current config hashes', () => {
  const jobService = readRepoFile('lib/disburse/job-service.ts');

  assert.match(jobService, /findCurrentRenderedClipForConfig/);
  assert.match(jobService, /findActiveFormatRenderJob/);
  assert.match(jobService, /payload->>'editConfigHash'/);
  assert.match(jobService, /eq\(renderedClips\.editConfigHash,\s*editConfigHash\)/);
});
