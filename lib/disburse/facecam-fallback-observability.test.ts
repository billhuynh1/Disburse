import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readRepoFile(path: string) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('facecam timeout and abort statuses are explicit terminal fallback states', () => {
  const schema = readRepoFile('lib/db/schema.ts');
  const gate = readRepoFile('lib/disburse/facecam-render-gate.ts');

  for (const status of [
    'FAILED_TIMEOUT',
    'FAILED_ABORTED',
    'FAILED_NETWORK',
    'FAILED_HTTP',
    'FAILED_INVALID_RESPONSE',
  ]) {
    assert.match(schema, new RegExp(`${status}\\s*=`));
    assert.match(gate, new RegExp(`FacecamDetectionStatus\\.${status}`));
  }
});

test('pipeline queues default render fallback with classified facecam reasons', () => {
  const pipeline = readRepoFile('lib/disburse/pipeline-service.ts');
  const facecamService = readRepoFile('lib/disburse/facecam-detection-service.ts');

  assert.match(pipeline, /getFacecamFailureStatusForError\(error\)/);
  assert.match(pipeline, /getFacecamFallbackQueueReason\(facecamFailureStatus\)/);
  assert.match(facecamService, /facecam_detection_failed_timeout/);
  assert.match(facecamService, /facecam_detection_failed_aborted/);
  assert.match(facecamService, /facecam_not_detected/);
});

test('facecam completion requeues generation if content-pack candidates disappeared', () => {
  const pipeline = readRepoFile('lib/disburse/pipeline-service.ts');

  assert.match(pipeline, /facecam_detection\.candidates_missing/);
  assert.match(pipeline, /facecam_completed_without_candidates/);
  assert.match(pipeline, /requeued_short_form_pack/);
  assert.match(pipeline, /facecam_detection\.fallback_candidates_missing/);
});

test('short-form reconciliation repairs candidates left in active facecam states', () => {
  const shortFormService = readRepoFile('lib/disburse/short-form-service.ts');

  assert.match(shortFormService, /short_form_pack\.facecam_reconcile_repair/);
  assert.match(shortFormService, /ACTIVE_FACECAM_DETECTION_STATUSES/);
  assert.match(shortFormService, /facecam_reconcile_repair/);
  assert.match(shortFormService, /getFacecamSegmentsForVideo/);
});
