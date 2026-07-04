import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAcknowledgeSourceAssetUploadPartRoute,
  createInitiateSourceAssetUploadRoute,
} from './source-asset-upload-route-handlers.ts';

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
