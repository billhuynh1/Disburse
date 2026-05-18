import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readRepoFile(path: string) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('facecam jobs use a video-level idempotency key with a database unique index', () => {
  const schema = readRepoFile('lib/db/schema.ts');
  const migration = readRepoFile(
    'lib/db/migrations/0023_video_facecam_segments.sql'
  );

  assert.match(schema, /idempotencyKey:\s*text\('idempotency_key'\)/);
  assert.match(schema, /uniqueIndex\('jobs_idempotency_key_idx'\)/);
  assert.match(migration, /ADD COLUMN "idempotency_key" text/);
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "jobs_idempotency_key_idx" ON "jobs"/
  );
});

test('facecam results are stored as video-level segments', () => {
  const schema = readRepoFile('lib/db/schema.ts');
  const migration = readRepoFile(
    'lib/db/migrations/0023_video_facecam_segments.sql'
  );

  for (const requiredColumn of [
    'start_time_ms',
    'end_time_ms',
    'x_px',
    'y_px',
    'width_px',
    'height_px',
    'confidence',
    'layout_type',
  ]) {
    assert.match(migration, new RegExp(`"${requiredColumn}"`));
  }

  assert.match(schema, /export const facecamSegments = pgTable/);
  assert.match(migration, /"facecam_segments"/);
});

test('short-form generation queues one video facecam job instead of per-candidate jobs', () => {
  const shortFormService = readRepoFile('lib/disburse/short-form-service.ts');

  assert.match(shortFormService, /enqueueDetectVideoFacecamJob/);
  assert.doesNotMatch(shortFormService, /enqueueDetectClipFacecamJob/);
  assert.doesNotMatch(
    shortFormService,
    /for \(const candidate of params\.candidates\) \{\s*await enqueueDetect/
  );
});
