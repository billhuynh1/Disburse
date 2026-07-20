import assert from 'node:assert/strict';
import test from 'node:test';

import { JobRecoveryMode } from '../db/schema.ts';
import {
  buildSafeRecoveryAuditMetadata,
  MAX_RECOVERY_REQUEST_BYTES,
  readBoundedJsonBody,
  recoveryRequestBodySchema,
  RecoveryRequestBodyError,
} from './recovery-request-body.ts';

test('recovery request bodies are bounded while streaming', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_RECOVERY_REQUEST_BYTES));
      controller.enqueue(new Uint8Array([1]));
      controller.close();
    },
  });
  await assert.rejects(
    readBoundedJsonBody(new Request('https://example.test', { method: 'POST', body, duplex: 'half' } as RequestInit)),
    (error: unknown) => error instanceof RecoveryRequestBodyError && error.code === 'body_too_large'
  );
});

test('recovery bodies reject extra secret fields and audit only allowlisted presence flags', () => {
  const raw = {
    mode: JobRecoveryMode.RETRY,
    idempotencyKey: 'request-1',
    providerToken: 'do-not-store',
  };
  assert.equal(recoveryRequestBodySchema.safeParse(raw).success, false);
  assert.deepEqual(buildSafeRecoveryAuditMetadata(raw), {
    hasMode: true,
    hasIdempotencyKey: true,
    hasExpectedCurrentGeneration: false,
  });
  assert.equal(JSON.stringify(buildSafeRecoveryAuditMetadata(raw)).includes('do-not-store'), false);
});
