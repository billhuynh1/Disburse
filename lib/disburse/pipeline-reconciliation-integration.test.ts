import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('stalled recovery and the internal processor do not drain reconciliation pages', () => {
  const jobService = readFileSync(
    new URL('./job-service.ts', import.meta.url),
    'utf8'
  );
  const recoveryStart = jobService.indexOf('export async function recoverStalledPipelineJobs');
  const recoveryEnd = jobService.indexOf('export async function enqueueYoutubeIngestionJob', recoveryStart);
  const recovery = jobService.slice(recoveryStart, recoveryEnd);
  const processRoute = readFileSync(
    new URL('../../app/api/internal/jobs/process/route.ts', import.meta.url),
    'utf8'
  );

  assert.doesNotMatch(recovery, /reconcilePipelinePage|nextAfterProjectId/);
  assert.doesNotMatch(processRoute, /reconcilePipelinePage|nextAfterProjectId/);
});
