import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('processor has bounded defaults, safe stop reasons, and one recovery pass', () => {
  const source = read('./pipeline-processor-service.ts');
  assert.match(source, /DEFAULT_PIPELINE_PROCESSOR_MAX_JOBS = 10/);
  assert.match(source, /DEFAULT_PIPELINE_RECONCILIATION_PROJECTS = 10/);
  assert.match(source, /DEFAULT_PIPELINE_RECOVERY_LIMIT = 100/);
  assert.match(source, /DEFAULT_PIPELINE_PROCESSOR_MAX_RUNTIME_MS = 720_000/);
  for (const reason of [
    'queue_empty', 'max_jobs', 'max_runtime', 'reconciliation_budget',
    'processor_busy', 'fatal_error',
  ]) {
    assert.match(source, new RegExp(`'${reason}'`));
  }
  assert.equal(source.match(/recoverExpiredPipelineJobLeases\(/g)?.length, 1);
  assert.match(source, /downstream: \{ trigger: \(\) => undefined \}/);
  assert.match(source, /options\.origin === 'internal'/);
  assert.doesNotMatch(source, /job\.payload|failureReason|downloadUrl|storageUrl/);
});

test('cron and internal routes use independent exact bearer secrets and safe errors', () => {
  const cron = read('../../app/api/cron/process-jobs/route.ts');
  const internal = read('../../app/api/internal/jobs/process/route.ts');
  for (const route of [cron, internal]) {
    assert.match(route, /maxDuration = 800/);
    assert.match(route, /dynamic = 'force-dynamic'/);
    assert.match(route, /Pipeline processing failed\./);
    assert.doesNotMatch(route, /error instanceof Error|error\.message/);
  }
  assert.match(cron, /process\.env\.CRON_SECRET/);
  assert.doesNotMatch(cron, /INTERNAL_PROCESSING_SECRET/);
  assert.match(cron, /request\.headers\.get\('authorization'\) !== `Bearer/);
  assert.match(cron, /process\.env\.NODE_ENV !== 'production'/);
  assert.match(internal, /process\.env\.INTERNAL_PROCESSING_SECRET/);
  assert.doesNotMatch(internal, /CRON_SECRET/);
});

test('deployment cron is every five minutes and cron never emits a follow-up', () => {
  const deployment = read('../../vercel.json');
  const processor = read('./pipeline-processor-service.ts');
  assert.deepEqual(JSON.parse(deployment), {
    crons: [{ path: '/api/cron/process-jobs', schedule: '*/5 * * * *' }],
  });
  assert.match(processor, /options\.origin === 'internal'/);
  assert.doesNotMatch(processor, /options\.origin === 'cron'.*triggerInternalJobProcessing/s);
});
