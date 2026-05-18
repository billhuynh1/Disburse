import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
