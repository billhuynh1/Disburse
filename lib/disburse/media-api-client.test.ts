import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readRepoFile(path: string) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('classifies configured AbortController aborts as timeout failures', () => {
  const client = readRepoFile('lib/disburse/media-api-client.ts');

  assert.match(client, /MEDIA_API_FACECAM_TIMEOUT_MS/);
  assert.match(client, /let timedOut = false/);
  assert.match(client, /timedOut = true/);
  assert.match(client, /kind: timedOut \? 'timeout' : 'aborted'/);
  assert.match(client, /expectedAbort: timedOut/);
});

test('valid zero-candidate facecam responses remain successful responses', () => {
  const client = readRepoFile('lib/disburse/media-api-client.ts');
  const service = readRepoFile('lib/disburse/facecam-detection-service.ts');

  assert.match(client, /candidates: z\.array\(mediaApiFacecamCandidateSchema\)/);
  assert.match(
    service,
    /params\.result\.candidates\.length > 0\s*\?\s*FacecamDetectionStatus\.READY\s*:\s*FacecamDetectionStatus\.NOT_FOUND/s
  );
});
