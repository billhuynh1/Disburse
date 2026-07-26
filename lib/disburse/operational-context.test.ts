import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getOperationalCorrelation,
  runWithOperationalInvocation,
} from './operational-context.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

test('operational invocation correlation remains isolated across overlapping async work', async () => {
  const firstReady = deferred();
  const secondReady = deferred();
  const firstContinue = deferred();
  const secondContinue = deferred();
  const firstId = '11111111-1111-4111-8111-111111111111';
  const secondId = '22222222-2222-4222-8222-222222222222';

  const first = runWithOperationalInvocation(
    { invocationId: firstId, origin: 'internal' },
    async () => {
      assert.deepEqual(getOperationalCorrelation(), { invocationId: firstId, origin: 'internal' });
      firstReady.resolve();
      await secondReady.promise;
      await firstContinue.promise;
      await Promise.resolve();
      assert.deepEqual(getOperationalCorrelation(), { invocationId: firstId, origin: 'internal' });
    }
  );
  const second = runWithOperationalInvocation(
    { invocationId: secondId, origin: 'cron' },
    async () => {
      assert.deepEqual(getOperationalCorrelation(), { invocationId: secondId, origin: 'cron' });
      secondReady.resolve();
      await firstReady.promise;
      await secondContinue.promise;
      await Promise.resolve();
      assert.deepEqual(getOperationalCorrelation(), { invocationId: secondId, origin: 'cron' });
    }
  );

  await Promise.all([firstReady.promise, secondReady.promise]);
  firstContinue.resolve();
  secondContinue.resolve();
  await Promise.all([first, second]);

  assert.deepEqual(getOperationalCorrelation(), {
    invocationId: '00000000-0000-4000-8000-000000000000',
  });
});
