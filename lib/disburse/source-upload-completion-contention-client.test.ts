import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SOURCE_UPLOAD_COMPLETION_IN_PROGRESS_CODE,
  UploadCompletionInProgressError,
  getSourceUploadLocalRecordForFile,
  isUploadInterruptedError,
  uploadSourceAssetMultipart,
} from '../../app/(dashboard)/dashboard/upload-client.ts';
import type { SourceUploadLocalRecord } from '../../app/(dashboard)/dashboard/upload-client.ts';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

test('retryable completion contention preserves resumable state and a later retry succeeds', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const localStorage = new MemoryStorage();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage },
  });

  const file = new File(['12345'], 'source.mp4', {
    type: 'video/mp4',
    lastModified: 1234,
  });
  const localRecord: SourceUploadLocalRecord = {
    projectId: 10,
    filename: file.name,
    fileSizeBytes: file.size,
    lastModified: file.lastModified,
    mimeType: file.type,
    title: 'Source',
    idempotencyKey: 'contention-idempotency',
    uploadSessionId: 42,
    uploadedPartCount: 1,
    totalParts: 1,
    percent: 99,
    status: 'uploading',
    updatedAt: new Date(0).toISOString(),
  };
  const requestedUrls: string[] = [];
  let completionRequests = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.endsWith('/status')) {
      return Response.json({
        session: { id: 42, partSizeBytes: 5, totalParts: 1 },
        uploadedParts: [{ partNumber: 1, etag: '"part-1"' }],
      });
    }
    if (url.endsWith('/complete')) {
      completionRequests += 1;
      if (completionRequests === 1) {
        return Response.json({
          error: 'This upload is still being finalized. Please retry shortly.',
          code: SOURCE_UPLOAD_COMPLETION_IN_PROGRESS_CODE,
          retryable: true,
        }, { status: 409, headers: { 'Retry-After': '2' } });
      }
      return Response.json({ sourceAsset: { id: 99 } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    await assert.rejects(
      uploadSourceAssetMultipart({
        file,
        projectId: 10,
        title: 'Source',
        localRecord,
        onProgress: () => undefined,
      }),
      (error: unknown) => {
        assert.ok(error instanceof UploadCompletionInProgressError);
        assert.equal(error.code, SOURCE_UPLOAD_COMPLETION_IN_PROGRESS_CODE);
        assert.equal(error.retryable, true);
        assert.equal(isUploadInterruptedError(error), false);
        return true;
      }
    );

    const preservedRecord = getSourceUploadLocalRecordForFile(10, file);
    assert.ok(preservedRecord);
    assert.equal(preservedRecord.status, 'paused');
    assert.equal(preservedRecord.uploadSessionId, 42);
    assert.equal(preservedRecord.idempotencyKey, 'contention-idempotency');
    assert.equal(preservedRecord.uploadedPartCount, 1);
    assert.equal(preservedRecord.totalParts, 1);
    assert.equal(completionRequests, 1);
    assert.equal(requestedUrls.some((url) => url.endsWith('/abort')), false);

    const result = await uploadSourceAssetMultipart({
      file,
      projectId: 10,
      title: 'Source',
      localRecord: preservedRecord,
      onProgress: () => undefined,
    });
    assert.equal(result.sourceAsset.id, 99);
    assert.equal(completionRequests, 2);
    assert.equal(requestedUrls.some((url) => url.endsWith('/abort')), false);
    assert.equal(getSourceUploadLocalRecordForFile(10, file), null);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
  }
});
