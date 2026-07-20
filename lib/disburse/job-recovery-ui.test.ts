import assert from 'node:assert/strict';
import test from 'node:test';

import { JobRecoveryOutcome } from '../db/schema.ts';
import { isAcceptedRecoveryResult, submitJobRecovery } from './job-recovery-client.ts';

test('UI success requires the canonical accepted outcome and a real successor', () => {
  assert.equal(isAcceptedRecoveryResult({ outcome: JobRecoveryOutcome.ACCEPTED, successorJobId: 42 }), true);
  assert.equal(isAcceptedRecoveryResult({ outcome: JobRecoveryOutcome.ACCEPTED, successorJobId: null }), false);
  assert.equal(isAcceptedRecoveryResult({ outcome: JobRecoveryOutcome.REJECTED, successorJobId: 42 }), false);
});

test('a rejected replay and an uncertain response never become UI success', async () => {
  const rejected = async () => new Response(JSON.stringify({
    outcome: JobRecoveryOutcome.REJECTED,
    code: 'active_successor_exists',
    successorJobId: null,
  }), { status: 409, headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(submitJobRecovery({
    jobId: 1,
    mode: 'retry',
    idempotencyKey: 'same-key',
    fetcher: rejected as typeof fetch,
  }), /active_successor_exists/);
  await assert.rejects(submitJobRecovery({
    jobId: 1,
    mode: 'retry',
    idempotencyKey: 'same-key',
    fetcher: (async () => { throw new TypeError('network response uncertain'); }) as typeof fetch,
  }), /network response uncertain/);
});
