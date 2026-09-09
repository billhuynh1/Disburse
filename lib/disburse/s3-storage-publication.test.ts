import assert from 'node:assert/strict';
import test from 'node:test';

import { uploadAndVerifyStorageObject } from './s3-storage.ts';

const storageEnv = {
  S3_UPLOAD_ACCESS_KEY_ID: 'test-access-key',
  S3_UPLOAD_SECRET_ACCESS_KEY: 'test-secret-key',
  S3_UPLOAD_BUCKET: 'test-bucket',
  S3_UPLOAD_REGION: 'us-east-1',
  S3_UPLOAD_ENDPOINT: 'https://storage.example.test',
  S3_UPLOAD_PATH_STYLE: 'true',
} as const;

async function withStorageFetch(
  responses: Response[],
  run: (requests: Array<{ url: string; init?: RequestInit }>) => Promise<void>
) {
  const originalFetch = globalThis.fetch;
  const originalEnv = Object.fromEntries(
    Object.keys(storageEnv).map((key) => [key, process.env[key]])
  );
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  Object.assign(process.env, storageEnv);
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), init });
    const response = responses.shift();
    if (!response) throw new Error('Unexpected storage request.');
    return response;
  }) as typeof fetch;

  try {
    await run(requests);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('PUT success plus exact-object verification completes publication', async () => {
  await withStorageFetch([
    new Response(null, { status: 200 }),
    new Response(null, { status: 200, headers: { 'content-length': '3' } }),
  ], async (requests) => {
    await uploadAndVerifyStorageObject({
      storageKey: 'renders/clip.mp4',
      mimeType: 'video/mp4',
      body: 'abc',
      expectedSizeBytes: 3,
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[0]!.init?.method, 'PUT');
    assert.equal(requests[1]!.init?.method, 'HEAD');
    assert.equal(new URL(requests[0]!.url).host, new URL(requests[1]!.url).host);
    assert.equal(new URL(requests[0]!.url).pathname, new URL(requests[1]!.url).pathname);
    assert.match(requests[0]!.url, /\/test-bucket\/renders\/clip\.mp4/);
  });
});

test('a missing object after PUT fails closed before READY can publish', async () => {
  await withStorageFetch([
    new Response(null, { status: 200 }),
    new Response(null, { status: 404 }),
  ], async (requests) => {
    await assert.rejects(
      uploadAndVerifyStorageObject({
        storageKey: 'renders/missing.mp4',
        mimeType: 'video/mp4',
        body: 'abc',
        expectedSizeBytes: 3,
      }),
      /verification failed with status 404/
    );
    assert.deepEqual(requests.map((request) => request.init?.method), ['PUT', 'HEAD']);
  });
});

test('a verified size mismatch fails closed before READY can publish', async () => {
  await withStorageFetch([
    new Response(null, { status: 200 }),
    new Response(null, { status: 200, headers: { 'content-length': '2' } }),
  ], async () => {
    await assert.rejects(
      uploadAndVerifyStorageObject({
        storageKey: 'renders/wrong-size.mp4',
        mimeType: 'video/mp4',
        body: 'abc',
        expectedSizeBytes: 3,
      }),
      /size mismatch/
    );
  });
});

test('a failed PUT prevents verification and READY publication', async () => {
  await withStorageFetch([
    new Response(null, { status: 500 }),
  ], async (requests) => {
    await assert.rejects(
      uploadAndVerifyStorageObject({
        storageKey: 'renders/put-failure.mp4',
        mimeType: 'video/mp4',
        body: 'abc',
      }),
      /upload failed with status 500/
    );
    assert.deepEqual(requests.map((request) => request.init?.method), ['PUT']);
  });
});
