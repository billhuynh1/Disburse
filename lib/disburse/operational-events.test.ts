import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyOperationalFailure, emitOperationalEvent, OPERATIONAL_STRING_FIELDS, OPERATIONAL_STRING_FIELD_VALUES, sanitizeOperationalEvent } from './operational-events.ts';

const invocationId = '123e4567-e89b-42d3-a456-426614174000';

test('operational events allow only bounded typed fields', () => {
  assert.deepEqual(sanitizeOperationalEvent('pipeline.invocation_completed', {
    invocationId, origin: 'cron', stopReason: 'queue_empty', durationMs: Number.MAX_SAFE_INTEGER,
    processedJobs: -10, reconciledProjects: 1.9, followUpTriggered: false,
    nested: { unsafe: true }, arbitrary: 'not-allowed',
  }), { event: 'pipeline.invocation_completed', invocationId, origin: 'cron', stopReason: 'queue_empty', durationMs: 86_400_000, processedJobs: 0, reconciledProjects: 1, followUpTriggered: false });
});

test('every allowed string field rejects malicious and merely well-formed unlisted values', () => {
  for (const field of OPERATIONAL_STRING_FIELDS) {
    for (const value of ['raw-job-key', 'private-transcript-words', 'https://example.invalid/X-Amz-Signature=secret', 'looks_valid_but_unlisted']) {
      const event = sanitizeOperationalEvent('pipeline.invocation_failed', { invocationId, [field]: value });
      if (field === 'failureCode') assert.equal(event.failureCode, 'unclassified_failure');
      else if (field === 'failureClass') assert.equal(event.failureClass, 'unknown');
      else assert.equal(field in event, false, `${field} accepted ${value}`);
    }
  }
});

test('every member of every closed operational enum is retained', () => {
  for (const [field, values] of Object.entries(OPERATIONAL_STRING_FIELD_VALUES)) {
    for (const value of values) {
      const event = sanitizeOperationalEvent('pipeline.invocation_failed', { invocationId, [field]: value });
      assert.equal(event[field], value, `${field} discarded ${value}`);
    }
  }
});

test('events never serialize secrets, content, provider responses, signed URLs, idempotency keys, or Errors', () => {
  const output: string[] = [];
  emitOperationalEvent('pipeline.invocation_failed', {
    invocationId, failureClass: 'unknown', failureCode: 'unclassified_failure',
    secret: 'super-secret', authorization: 'Bearer private', payload: { transcript: 'private-transcript-words' },
    transcript: 'private-transcript-words', providerResponse: { choices: ['private'] },
    signedUrl: 'https://storage.invalid/file?X-Amz-Signature=private', idempotencyKey: 'raw-job-key',
    error: new Error('private-transcript-words'),
  }, value => output.push(value));
  assert.doesNotMatch(output[0]!, /private|transcript|payload|response|url|idempotency|stack|error|raw-job-key/i);
});

test('event names, identifiers, and failure codes are closed', () => {
  assert.throws(() => sanitizeOperationalEvent('not.allowlisted' as 'pipeline.invocation_started', {}), /not allowlisted/);
  assert.equal(sanitizeOperationalEvent('pipeline.invocation_started', { invocationId: '../../raw-job-key', origin: 'internal' }).invocationId, '00000000-0000-4000-8000-000000000000');
  assert.deepEqual(classifyOperationalFailure({ code: 'private-transcript-words' }), { failureClass: 'unknown', failureCode: 'unclassified_failure' });
  assert.deepEqual(classifyOperationalFailure(new Error('raw-job-key')), { failureClass: 'unknown', failureCode: 'unclassified_failure' });
  assert.deepEqual(classifyOperationalFailure({ code: 'invalid_checkpoint_result' }), { failureClass: 'permanent', failureCode: 'invalid_checkpoint_result' });
  assert.equal(sanitizeOperationalEvent('pipeline.recovery_outcome', { invocationId, recoveryOutcome: 'duplicate' }).recoveryOutcome, 'duplicate');
});
