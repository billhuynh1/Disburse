import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readRepoFile(path: string) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('short-form reconciliation is scoped to a generation/content/source triple', () => {
  const shortFormService = readRepoFile('lib/disburse/short-form-service.ts');
  const pipelineService = readRepoFile('lib/disburse/pipeline-service.ts');

  assert.match(shortFormService, /type ReconcileShortFormContentPackStatusParams = \{/);
  assert.match(shortFormService, /contentPack\.sourceAssetId !== params\.sourceAssetId/);
  assert.match(shortFormService, /contentPack\.generationRunId !== params\.generationRunId/);
  assert.doesNotMatch(pipelineService, /reconcileShortFormContentPackStatus\(job\.payload\.contentPackId\)/);
  assert.match(pipelineService, /reconcileShortFormContentPackStatus\(\{\s*contentPackId:/);
});

test('render job claiming is deterministic by candidate rank and creation time', () => {
  const jobService = readRepoFile('lib/disburse/job-service.ts');

  assert.doesNotMatch(jobService, /left join "clip_candidates" render_candidates/);
  assert.match(jobService, /select render_candidates\."rank"/);
  assert.match(jobService, /select render_candidates\."created_at"/);
  assert.match(jobService, /"jobs"\."created_at" asc/);
});

test('active short-form reconciliation does not repeatedly touch unchanged packs', () => {
  const shortFormService = readRepoFile('lib/disburse/short-form-service.ts');

  assert.match(shortFormService, /updateShortFormPackStatusIfChanged/);
  assert.match(shortFormService, /contentPack\.status === status/);
  assert.match(shortFormService, /contentPack\.failureReason \?\? null/);
  assert.match(shortFormService, /ContentPackStatus\.GENERATING,\s*null/);
});

test('status endpoint exposes aggregate short-form generation progress', () => {
  const queries = readRepoFile('lib/db/queries.ts');
  const route = readRepoFile('app/api/transcripts/statuses/route.ts');

  assert.match(queries, /export async function listShortFormGenerationProgressStatuses/);
  assert.match(queries, /totalCandidateCount/);
  assert.match(queries, /readyRenderCount/);
  assert.match(queries, /activeRenderCount/);
  assert.match(route, /shortFormGenerationProgressItems/);
});
