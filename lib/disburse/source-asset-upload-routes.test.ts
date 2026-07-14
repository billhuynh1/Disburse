import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAcknowledgeSourceAssetUploadPartRoute,
  createCompleteSourceAssetUploadRoute,
  createInitiateSourceAssetUploadRoute,
} from './source-asset-upload-route-handlers.ts';
import {
  SourceUploadCompletionInProgressError,
} from './source-asset-upload-service-core.ts';
import { SOURCE_UPLOAD_COMPLETION_IN_PROGRESS_CODE } from './source-upload-completion-contract.ts';

test('initiate upload route rejects unauthorized requests', async () => {
  const POST = createInitiateSourceAssetUploadRoute({
    getUser: async () => null,
    action: async () => {
      throw new Error('should not be called');
    },
  });

  const response = await POST(
    new Request('http://localhost/api/source-assets/uploads/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Unauthorized' });
});

test('part ack route rejects invalid payloads before calling the service', async () => {
  let serviceCalled = false;
  const POST = createAcknowledgeSourceAssetUploadPartRoute({
    getUser: async () => ({ id: 1 } as never),
    action: async () => {
      serviceCalled = true;
      return {};
    },
    schema: {
      safeParse: () => ({
        success: false as const,
        error: { errors: [{ message: 'Invalid part acknowledgement.' }] },
      }),
    },
  });

  const response = await POST(
    new Request('http://localhost/api/source-assets/uploads/part-ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: 'Invalid part acknowledgement.',
  });
  assert.equal(serviceCalled, false);
});

function createValidCompletionSchema() {
  return {
    safeParse: () => ({
      success: true as const,
      data: { uploadSessionId: 1, title: 'Source' },
    }),
  };
}

test('completion route returns a typed retryable conflict for completion contention', async () => {
  const POST = createCompleteSourceAssetUploadRoute({
    getUser: async () => ({ id: 1 } as never),
    action: async () => {
      throw new SourceUploadCompletionInProgressError();
    },
    schema: createValidCompletionSchema(),
  });

  const response = await POST(new Request(
    'http://localhost/api/source-assets/uploads/complete',
    { method: 'POST', body: '{}' }
  ));

  assert.equal(response.status, 409);
  assert.equal(response.headers.get('Retry-After'), '2');
  assert.deepEqual(await response.json(), {
    error: 'This upload is still being finalized. Please retry shortly.',
    code: SOURCE_UPLOAD_COMPLETION_IN_PROGRESS_CODE,
    retryable: true,
  });
});

test('completion route preserves permanent error classification and safe messages', async () => {
  const notFoundRoute = createCompleteSourceAssetUploadRoute({
    getUser: async () => ({ id: 1 } as never),
    action: async () => { throw new Error('Project not found.'); },
    schema: createValidCompletionSchema(),
  });
  const permanentFailureRoute = createCompleteSourceAssetUploadRoute({
    getUser: async () => ({ id: 1 } as never),
    action: async () => { throw new Error('sensitive storage detail'); },
    schema: createValidCompletionSchema(),
  });

  const notFound = await notFoundRoute(new Request('http://localhost', {
    method: 'POST',
    body: '{}',
  }));
  const permanentFailure = await permanentFailureRoute(new Request('http://localhost', {
    method: 'POST',
    body: '{}',
  }));

  assert.equal(notFound.status, 404);
  assert.deepEqual(await notFound.json(), { error: 'Project not found.' });
  assert.equal(permanentFailure.status, 400);
  assert.deepEqual(await permanentFailure.json(), {
    error: 'Unable to finish this upload right now.',
  });
  assert.equal(permanentFailure.headers.get('Retry-After'), null);
});
