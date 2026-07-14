import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

register('../test/typescript-path-loader.mjs', import.meta.url);

function installStalledFetch() {
  const originalFetch = globalThis.fetch;
  const observedSignals: AbortSignal[] = [];
  globalThis.fetch = (async (_input, init) => {
    const signal = init?.signal;
    assert.ok(signal instanceof AbortSignal);
    observedSignals.push(signal);
    return await new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  }) as typeof fetch;
  return {
    observedSignals,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

test('production HTTP integration boundaries honor the composed operation deadline', async () => {
  process.env.POSTGRES_URL ||= 'postgres://postgres:postgres@localhost:5432/postgres';
  process.env.OPENAI_API_KEY = 'deadline-test';
  process.env.MEDIA_API_BASE_URL = 'https://media.invalid';
  process.env.MEDIA_API_SECRET = 'deadline-test';
  process.env.S3_UPLOAD_ACCESS_KEY_ID = 'deadline-test';
  process.env.S3_UPLOAD_SECRET_ACCESS_KEY = 'deadline-test';
  process.env.S3_UPLOAD_BUCKET = 'deadline-test';
  process.env.S3_UPLOAD_REGION = 'us-east-1';
  process.env.S3_UPLOAD_ENDPOINT = 'https://storage.invalid';
  process.env.S3_UPLOAD_PATH_STYLE = 'true';

  const { transcribeWithOpenAI } = await import('./openai-transcription.ts');
  const { rankShortFormClipWindows } = await import('./openai-short-form.ts');
  const { generatePackageAssets } = await import('./openai-package-assets.ts');
  const { detectFacecamRegions } = await import('./media-api-client.ts');
  const youtube = await import('./youtube-ingestion-service.ts');
  const publishing = await import('./publishing-service.ts');
  const rendering = await import('./rendered-clip-service.ts');
  const transcriptionPrep = await import('./transcription-prep-service.ts');

  const stalled = installStalledFetch();
  try {
    const operations = [
      (signal: AbortSignal) => transcribeWithOpenAI({
        file: new Blob(['audio']), filename: 'audio.mp3', signal,
      }),
      (signal: AbortSignal) => rankShortFormClipWindows({
        sourceTitle: 'source', clipLength: '30-60s', autoHookEnabled: true,
        targetClipDurationMs: { min: 10_000, max: 30_000 },
        targetCandidateRange: { min: 1, max: 2 },
        windows: [{ id: 'window-1', startTimeMs: 0, endTimeMs: 20_000,
          durationMs: 20_000, transcriptExcerpt: 'grounded text' }],
        signal,
      }),
      (signal: AbortSignal) => generatePackageAssets({
        sourceTitle: 'source', contentPackage: 'full_content_pack',
        candidates: [{ rank: 1, hook: 'hook', title: 'title', captionCopy: 'copy',
          summary: 'summary', transcriptExcerpt: 'text', whyItWorks: 'why',
          platformFit: 'fit' }], signal,
      }),
      (signal: AbortSignal) => detectFacecamRegions({
        sourceDownloadUrl: 'https://storage.invalid/source', sourceFilename: 'source.mp4',
        startTimeMs: 0, endTimeMs: 10_000,
      }, signal),
      (signal: AbortSignal) => youtube.fetchYouTubeWatchPage('video', signal),
      (signal: AbortSignal) => youtube.fetchCaptionTrack(
        'https://youtube.invalid/captions', signal
      ),
      (signal: AbortSignal) => publishing.downloadRenderedClipFile('clip.mp4', signal),
      (signal: AbortSignal) => publishing.startYoutubeResumableUpload({
        accessToken: 'token', mimeType: 'video/mp4', fileSizeBytes: 1,
        title: 'title', description: 'description', signal,
      }),
      (signal: AbortSignal) => publishing.uploadVideoToYoutube({
        accessToken: 'token', uploadUrl: 'https://youtube.invalid/upload',
        mimeType: 'video/mp4', body: Buffer.from('x'), signal,
      }),
      (signal: AbortSignal) => rendering.downloadStorageFile('source.mp4', signal),
      (signal: AbortSignal) => transcriptionPrep.downloadSourceAssetBuffer(
        'source.mp4', signal
      ),
    ];

    for (const operation of operations) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(
        new DOMException('Deadline exceeded', 'TimeoutError')
      ), 15);
      try {
        await assert.rejects(operation(controller.signal), (error) =>
          error instanceof Error && (
            error.name === 'TimeoutError' ||
            error.name === 'AbortError' ||
            error.name === 'MediaApiFacecamDetectionError'
          )
        );
        assert.equal(controller.signal.aborted, true);
      } finally {
        clearTimeout(timeout);
      }
    }
    assert.equal(stalled.observedSignals.length, operations.length);
    assert.ok(stalled.observedSignals.every((signal) => signal.aborted));
  } finally {
    stalled.restore();
  }
});

test('operation deadlines abort stalled production response-body consumption', async () => {
  process.env.POSTGRES_URL ||= 'postgres://postgres:postgres@localhost:5432/postgres';
  process.env.S3_UPLOAD_ACCESS_KEY_ID = 'deadline-test';
  process.env.S3_UPLOAD_SECRET_ACCESS_KEY = 'deadline-test';
  process.env.S3_UPLOAD_BUCKET = 'deadline-test';
  process.env.S3_UPLOAD_REGION = 'us-east-1';
  process.env.S3_UPLOAD_ENDPOINT = 'https://storage.invalid';
  process.env.S3_UPLOAD_PATH_STYLE = 'true';
  const youtube = await import('./youtube-ingestion-service.ts');
  const rendering = await import('./rendered-clip-service.ts');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    const signal = init?.signal;
    assert.ok(signal instanceof AbortSignal);
    const body = new ReadableStream({
      start(controller) {
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  try {
    for (const operation of [
      (signal: AbortSignal) => youtube.fetchYouTubeWatchPage('video', signal),
      (signal: AbortSignal) => rendering.downloadStorageFile('source.mp4', signal),
    ]) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(
        new DOMException('Deadline exceeded', 'TimeoutError')
      ), 15);
      try {
        await assert.rejects(operation(controller.signal), (error) =>
          error instanceof Error && error.name === 'TimeoutError'
        );
      } finally {
        clearTimeout(timeout);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('thumbnail subprocesses are killed by the operation signal', async () => {
  process.env.POSTGRES_URL ||= 'postgres://postgres:postgres@localhost:5432/postgres';
  const { runProcess } = await import('./source-asset-thumbnail-service.ts');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25);
  const startedAt = Date.now();
  try {
    await assert.rejects(
      runProcess(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        controller.signal
      ),
      (error) => error instanceof Error && error.name === 'AbortError'
    );
    assert.ok(Date.now() - startedAt < 1_000);
  } finally {
    clearTimeout(timeout);
  }
});
