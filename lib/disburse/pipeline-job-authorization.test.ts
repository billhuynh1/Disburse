import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function readRepoFile(path: string) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

test('every pipeline job is authorized before processor dispatch', () => {
  const pipeline = readRepoFile('lib/disburse/pipeline-service.ts');
  const processorStart = pipeline.indexOf('export async function processNextJob');
  const dispatch = pipeline.slice(
    processorStart,
    pipeline.indexOf('switch (job.type)', processorStart)
  );

  assert.match(dispatch, /const authority = getJobExecutionAuthority\(job\)/);
  assert.match(dispatch, /await assertJobExecutionAuthorized\(authority\)/);
  assert.match(dispatch, /heartbeatLostAuthority = true/);
});

test('external processor services receive or enforce execution authority', () => {
  const pipeline = readRepoFile('lib/disburse/pipeline-service.ts');
  const services = [
    'transcription-service.ts',
    'source-asset-thumbnail-service.ts',
    'youtube-ingestion-service.ts',
    'short-form-service.ts',
    'rendered-clip-service.ts',
    'facecam-detection-service.ts',
    'publishing-service.ts',
  ].map((name) => readRepoFile(`lib/disburse/${name}`));

  for (const jobType of [
    'TRANSCRIBE_SOURCE_ASSET',
    'EXTRACT_SOURCE_ASSET_THUMBNAIL',
    'INGEST_YOUTUBE_SOURCE_ASSET',
    'GENERATE_SHORT_FORM_PACK',
    'RENDER_CLIP_CANDIDATE',
    'FORMAT_RENDERED_CLIP_SHORT_FORM',
    'DETECT_CLIP_FACECAM',
    'PUBLISH_RENDERED_CLIP',
  ]) {
    assert.match(pipeline, new RegExp(`case JobType\\.${jobType}`));
  }

  for (const service of services) {
    assert.match(service, /JobExecutionAuthority/);
    assert.match(service, /withAuthorizedJobTransaction/);
  }
});

test('success and failure terminal effects use authorized transactions', () => {
  const pipeline = readRepoFile('lib/disburse/pipeline-service.ts');
  const jobs = readRepoFile('lib/disburse/job-service.ts');

  assert.match(pipeline, /withAuthorizedJobCompletion/);
  assert.match(pipeline, /withAuthorizedJobFailure/);
  assert.match(pipeline, /failure_suppressed_unauthorized/);
  assert.match(jobs, /export async function withAuthorizedJobCompletion/);
  assert.match(jobs, /export async function withAuthorizedJobFailure/);
  assert.match(jobs, /leaseExpiresAt} > clock_timestamp\(\)/);
});
