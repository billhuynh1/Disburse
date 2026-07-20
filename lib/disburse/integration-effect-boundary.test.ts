import assert from 'node:assert/strict';
import test from 'node:test';

import { withExternalEffectBoundary } from './job-effect-checkpoint-service.ts';
import { detectFacecamRegions } from './media-api-client.ts';
import { generatePackageAssets } from './openai-package-assets.ts';
import { transcribeWithOpenAI } from './openai-transcription.ts';
import { uploadStorageObject } from './s3-storage.ts';

const envKeys = [
  'OPENAI_API_KEY',
  'MEDIA_API_BASE_URL',
  'MEDIA_API_SECRET',
  'S3_UPLOAD_ACCESS_KEY_ID',
  'S3_UPLOAD_SECRET_ACCESS_KEY',
  'S3_UPLOAD_BUCKET',
  'S3_UPLOAD_REGION',
  'S3_UPLOAD_ENDPOINT',
  'S3_UPLOAD_PATH_STYLE',
] as const;

test('integration boundaries run immediately before OpenAI, S3, and facecam sends', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const events: string[] = [];
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.MEDIA_API_BASE_URL = 'https://media.example.test';
  process.env.MEDIA_API_SECRET = 'test-secret';
  process.env.S3_UPLOAD_ACCESS_KEY_ID = 'test-access';
  process.env.S3_UPLOAD_SECRET_ACCESS_KEY = 'test-secret';
  process.env.S3_UPLOAD_BUCKET = 'test-bucket';
  process.env.S3_UPLOAD_REGION = 'us-east-1';
  process.env.S3_UPLOAD_ENDPOINT = 'https://s3.example.test';
  process.env.S3_UPLOAD_PATH_STYLE = 'true';
  globalThis.fetch = (async () => {
    events.push('send');
    return new Response(JSON.stringify({ error: { message: 'failure' } }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const calls = [
    () => transcribeWithOpenAI({ file: new Blob(['x']), filename: 'x.mp3' }),
    () => generatePackageAssets({
      sourceTitle: 'source',
      contentPackage: 'clips_x_posts',
      candidates: [{ rank: 1, hook: 'h', title: 't', captionCopy: 'c', summary: 's', transcriptExcerpt: 'e', whyItWorks: 'w', platformFit: 'p' }],
    }),
    () => uploadStorageObject({ storageKey: 'x', mimeType: 'text/plain', body: 'x' }),
    () => detectFacecamRegions({
      sourceDownloadUrl: 'https://source.example.test/x',
      sourceFilename: 'x.mp4',
      startTimeMs: 0,
      endTimeMs: 1000,
      samplingIntervalMs: 500,
    }),
  ];
  try {
    for (const call of calls) {
      events.length = 0;
      await assert.rejects(withExternalEffectBoundary(async () => {
        events.push('boundary');
      }, call));
      assert.deepEqual(events, ['boundary', 'send']);
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('configuration failures remain before the external-effect boundary', async () => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  let began = false;
  try {
    await assert.rejects(withExternalEffectBoundary(async () => { began = true; }, async () =>
      await transcribeWithOpenAI({ file: new Blob(['x']), filename: 'x.mp3' })
    ));
    assert.equal(began, false);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});
