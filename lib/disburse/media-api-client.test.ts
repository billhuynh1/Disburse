import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

register('../test/typescript-path-loader.mjs', import.meta.url);

test('classifies the centralized facecam timeout as a timeout failure', async () => {
  process.env.POSTGRES_URL ||= 'postgres://postgres:postgres@localhost:5432/postgres';
  process.env.MEDIA_API_BASE_URL = 'https://media.invalid';
  process.env.MEDIA_API_SECRET = 'test-secret';
  const originalTimeout = process.env.MEDIA_API_FACECAM_TIMEOUT_MS;
  const originalFetch = globalThis.fetch;
  process.env.MEDIA_API_FACECAM_TIMEOUT_MS = '10';
  globalThis.fetch = (async (_input, init) => {
    const signal = init?.signal;
    assert.ok(signal instanceof AbortSignal);
    return await new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(
        new DOMException('Aborted', 'AbortError')
      ), { once: true });
    });
  }) as typeof fetch;
  try {
    const { detectFacecamRegions, MediaApiFacecamDetectionError } =
      await import('./media-api-client.ts');
    await assert.rejects(
      detectFacecamRegions({
        sourceDownloadUrl: 'https://storage.invalid/source.mp4',
        sourceFilename: 'source.mp4',
        startTimeMs: 0,
        endTimeMs: 1_000,
      }),
      (error) => error instanceof MediaApiFacecamDetectionError &&
        error.kind === 'timeout' && error.expectedAbort && error.timeoutMs === 10
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTimeout === undefined) delete process.env.MEDIA_API_FACECAM_TIMEOUT_MS;
    else process.env.MEDIA_API_FACECAM_TIMEOUT_MS = originalTimeout;
  }
});

test('accepts a valid zero-candidate facecam provider response', async () => {
  process.env.POSTGRES_URL ||= 'postgres://postgres:postgres@localhost:5432/postgres';
  process.env.MEDIA_API_BASE_URL = 'https://media.invalid';
  process.env.MEDIA_API_SECRET = 'test-secret';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    frameWidth: 1920,
    frameHeight: 1080,
    sampledFrameCount: 4,
    candidates: [],
  })) as typeof fetch;
  try {
    const { detectFacecamRegions } = await import('./media-api-client.ts');
    const result = await detectFacecamRegions({
      sourceDownloadUrl: 'https://storage.invalid/source.mp4',
      sourceFilename: 'source.mp4',
      startTimeMs: 0,
      endTimeMs: 1_000,
    });
    assert.deepEqual(result.candidates, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
