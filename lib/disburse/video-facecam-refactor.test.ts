import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readRepoFile(path: string) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('facecam jobs use candidate-scoped idempotency with a database unique index', () => {
  const schema = readRepoFile('lib/db/schema.ts');
  const migration = readRepoFile(
    'lib/db/migrations/0028_candidate_facecam_detection_runs.sql'
  );
  const facecamService = readRepoFile(
    'lib/disburse/facecam-detection-service.ts'
  );

  assert.match(schema, /idempotencyKey:\s*text\('idempotency_key'\)/);
  assert.match(schema, /uniqueIndex\('jobs_idempotency_key_idx'\)/);
  assert.match(migration, /"clip_candidate_facecam_detection_runs"/);
  assert.match(migration, /"clip_candidate_facecam_detection_runs_key_idx"/);
  assert.match(facecamService, /buildCandidateFacecamIdempotencyKey/);
  assert.match(facecamService, /candidate:\$\{params\.clipCandidateId\}/);
  assert.match(facecamService, /detector:\$\{params\.detectorVersion/);
});

test('candidate facecam results are stored under explicit detection runs', () => {
  const schema = readRepoFile('lib/db/schema.ts');
  const migration = readRepoFile(
    'lib/db/migrations/0028_candidate_facecam_detection_runs.sql'
  );

  for (const requiredColumn of [
    'x_px',
    'y_px',
    'width_px',
    'height_px',
    'confidence',
  ]) {
    assert.match(schema, new RegExp(requiredColumn.replace(/_([a-z])/g, (_, char) => char.toUpperCase())));
  }

  assert.match(migration, /"detection_run_id"/);
  assert.match(migration, /"detector_version"/);
  assert.match(migration, /"start_time_ms"/);
  assert.match(migration, /"end_time_ms"/);
  assert.match(schema, /clipCandidateFacecamDetectionRuns = pgTable/);
  assert.match(schema, /detectionRunId: integer\('detection_run_id'\)/);
  assert.match(schema, /runRankIdx: uniqueIndex/);
  assert.match(schema, /export const facecamSegments = pgTable/);
});

test('short-form generation queues candidate facecam jobs instead of one video job', () => {
  const shortFormService = readRepoFile('lib/disburse/short-form-service.ts');

  assert.match(shortFormService, /enqueueDetectCandidateFacecamJob/);
  assert.doesNotMatch(shortFormService, /enqueueDetectVideoFacecamJob/);
  assert.match(
    shortFormService,
    /for \(const candidate of params\.candidates\) \{\s*const enqueueResult = await enqueueDetectCandidateFacecamJob/
  );
});

test('pipeline processes candidate facecam jobs while preserving legacy video fallback', () => {
  const pipeline = readRepoFile('lib/disburse/pipeline-service.ts');
  const jobService = readRepoFile('lib/disburse/job-service.ts');

  assert.match(jobService, /candidateDetectClipFacecamJobPayloadSchema/);
  assert.match(jobService, /detectionRunId: z\.number\(\)\.int\(\)\.positive\(\)/);
  assert.match(jobService, /legacyDetectClipFacecamJobPayloadSchema/);
  assert.match(pipeline, /detectCandidateFacecam/);
  assert.match(pipeline, /detectVideoFacecam/);
  assert.match(pipeline, /markCandidateFacecamDetectionFailed/);
  assert.match(pipeline, /markVideoFacecamDetectionFailed/);
});

test('render uses candidate detection before video segment fallback', () => {
  const facecamService = readRepoFile(
    'lib/disburse/facecam-detection-service.ts'
  );
  const renderedClipService = readRepoFile(
    'lib/disburse/rendered-clip-service.ts'
  );

  assert.match(facecamService, /getFacecamDetectionForRender/);
  assert.match(facecamService, /candidate_detection/);
  assert.match(facecamService, /video_segment_fallback/);
  assert.match(renderedClipService, /getFacecamDetectionForRender/);
  assert.doesNotMatch(renderedClipService, /getFacecamSegmentForClip/);
});
