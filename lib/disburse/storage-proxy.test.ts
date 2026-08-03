import assert from 'node:assert/strict';
import test from 'node:test';
import { runWithOperationalInvocation } from './operational-context.ts';
import { fetchPresignedAsset } from './storage-proxy.ts';

const correlatedInvocationId = '123e4567-e89b-42d3-a456-426614174000';
const zeroInvocationId = '00000000-0000-4000-8000-000000000000';

async function assertSafeFetchFailure(invocationId: string | null) {
  const events: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalConsoleInfo = console.info;
  globalThis.fetch = async () => {
    const error = Object.assign(new Error('private storage response body'), {
      code: 'operational_fault_injected',
    });
    throw error;
  };
  console.info = (value: unknown) => { events.push(String(value)); };

  try {
    const operation = () => fetchPresignedAsset({
      url: 'https://private-storage.invalid/object?signature=private',
      method: 'GET',
      headers: { authorization: 'Bearer private-header' },
      failureLabel: 'Source asset',
      logContext: { sourceAssetId: 7, storageKey: 'private-storage-key' },
    });
    const result = invocationId
      ? await runWithOperationalInvocation({ invocationId, origin: 'internal' }, operation)
      : await operation();

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorResponse.status, 502);
      assert.deepEqual(await result.errorResponse.json(), {
        error: 'Source asset could not be loaded because storage was unreachable.',
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
    console.info = originalConsoleInfo;
  }

  assert.equal(events.length, 1);
  assert.deepEqual(JSON.parse(events[0]!), {
    event: 'pipeline.provider_boundary',
    invocationId: invocationId ?? zeroInvocationId,
    ...(invocationId ? { origin: 'internal' } : {}),
    provider: 's3',
    boundary: 'fetch_failed',
    sourceAssetId: 7,
    failureClass: 'transient',
    failureCode: 'operational_fault_injected',
  });
  assert.doesNotMatch(
    events[0]!,
    /private-storage|signature|authorization|private-header|response body|https|invalid/i
  );
}

test('storage proxy emits a safe fetch boundary event with inherited invocation correlation', async () => {
  await assertSafeFetchFailure(correlatedInvocationId);
});

test('storage proxy preserves the zero invocation UUID without correlation', async () => {
  await assertSafeFetchFailure(null);
});
