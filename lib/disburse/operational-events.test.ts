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

test('pipeline failure taxonomy is mapped to the closed operational vocabulary', () => {
  const mapped = sanitizeOperationalEvent('pipeline.invocation_failed', {
    invocationId,
    failureClass: 'safe_no_external_effect',
    failureCode: 'external_effect_ambiguous',
  });
  assert.equal(mapped.failureClass, 'safe_retry');
  assert.equal(mapped.failureCode, 'ambiguous_external_effect');
  assert.deepEqual(classifyOperationalFailure({ code: 'external_effect_ambiguous' }), {
    failureClass: 'ambiguous_external_effect',
    failureCode: 'ambiguous_external_effect',
  });
  assert.deepEqual(classifyOperationalFailure({ code: 'pipeline_failure_permanent' }), {
    failureClass: 'permanent',
    failureCode: 'unclassified_failure',
  });
  assert.deepEqual(sanitizeOperationalEvent('pipeline.invocation_failed', {
    invocationId,
    failureClass: 'safe_retry',
    failureCode: 'external_effect_not_started',
  }), {
    event: 'pipeline.invocation_failed',
    invocationId,
    failureClass: 'safe_retry',
    failureCode: 'external_effect_not_started',
  });
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
  const unknown = emitOperationalEvent('pipeline.invocation_failed', {
    invocationId,
    failureClass: 'private-transcript-words',
    failureCode: 'private-transcript-words',
  }, () => undefined);
  assert.equal(unknown.failureClass, 'unknown');
  assert.equal(unknown.failureCode, 'unclassified_failure');
  assert.doesNotMatch(JSON.stringify(unknown), /private-transcript-words/);
  assert.deepEqual(classifyOperationalFailure({ code: 'invalid_checkpoint_result' }), { failureClass: 'permanent', failureCode: 'invalid_checkpoint_result' });
  assert.equal(sanitizeOperationalEvent('pipeline.recovery_outcome', { invocationId, recoveryOutcome: 'duplicate' }).recoveryOutcome, 'duplicate');
});
