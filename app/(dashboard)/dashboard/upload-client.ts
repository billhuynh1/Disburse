'use client';

type ProgressSnapshot = {
  loaded: number;
  total: number;
  percent: number;
  etaSeconds: number | null;
};

type MultipartProgressSnapshot = ProgressSnapshot & {
  label?: string;
};

export const UPLOAD_PAUSED_ERROR_MESSAGE = 'Upload paused.';
export const UPLOAD_INTERRUPTED_ERROR_MESSAGE = 'Upload failed.';

export class UploadPausedError extends Error {
  constructor() {
    super(UPLOAD_PAUSED_ERROR_MESSAGE);
    this.name = 'UploadPausedError';
  }
}

export class UploadInterruptedError extends Error {
  constructor() {
    super(UPLOAD_INTERRUPTED_ERROR_MESSAGE);
    this.name = 'UploadInterruptedError';
  }
}

export type SourceUploadLocalRecord = {
  projectId: number;
  filename: string;
  fileSizeBytes: number;
  lastModified: number;
  mimeType: string;
  title: string;
  idempotencyKey: string;
  uploadSessionId: number | null;
  uploadedPartCount: number;
  totalParts: number | null;
  percent: number;
  status: 'uploading' | 'paused' | 'completed' | 'failed';
  updatedAt: string;
};

const SOURCE_UPLOAD_RECORD_PREFIX = 'disburse-source-upload-record';

export function isUploadPausedError(error: unknown) {
  return (
    error instanceof UploadPausedError ||
    (error instanceof Error && error.message === UPLOAD_PAUSED_ERROR_MESSAGE)
  );
}

export function isUploadInterruptedError(error: unknown) {
  return (
    error instanceof UploadInterruptedError ||
    (error instanceof Error && error.message === UPLOAD_INTERRUPTED_ERROR_MESSAGE)
  );
}

function assertNotPaused(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new UploadPausedError();
  }
}

export async function readJsonResponse(response: Response) {
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(body?.error || 'Request failed.');
  }

  return body;
}

export function formatUploadEta(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 1) {
    return 'Estimating...';
  }

  if (seconds < 60) {
    return `${Math.ceil(seconds)}s remaining`;
  }

  return `${Math.ceil(seconds / 60)}m remaining`;
}

export function uploadToStorageWithProgress(params: {
  uploadUrl: string;
  method: string;
  headers: Record<string, string>;
  file: File;
  signal?: AbortSignal;
  onProgress: (progress: ProgressSnapshot) => void;
}) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const startedAt = Date.now();

    xhr.open(params.method, params.uploadUrl);

    Object.entries(params.headers || {}).forEach(([key, value]) => {
      xhr.setRequestHeader(key, value);
    });

    params.signal?.addEventListener('abort', () => {
      xhr.abort();
      reject(new Error('Upload canceled.'));
    });

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) {
        return;
      }

      const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.1);
      const bytesPerSecond = event.loaded / elapsedSeconds;
      const remainingBytes = Math.max(event.total - event.loaded, 0);
      const etaSeconds =
        bytesPerSecond > 0 ? remainingBytes / bytesPerSecond : null;

      params.onProgress({
        loaded: event.loaded,
        total: event.total,
        percent: Math.min(100, Math.round((event.loaded / event.total) * 100)),
        etaSeconds
      });
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        params.onProgress({
          loaded: params.file.size,
          total: params.file.size,
          percent: 100,
          etaSeconds: 0
        });
        resolve();
        return;
      }

      reject(
        new Error(
          `File upload failed before it could be attached (storage returned ${xhr.status}).`
        )
      );
    };

    xhr.onerror = () => reject(new Error('File upload failed.'));
    xhr.onabort = () => reject(new Error('Upload canceled.'));
    xhr.send(params.file);
  });
}

function getUploadIdempotencyKey(projectId: number, file: File) {
  const storageKey = getUploadIdempotencyStorageKey(projectId, file);
  const existing = window.localStorage.getItem(storageKey);

  if (existing) {
    return existing;
  }

  const value = crypto.randomUUID();
  window.localStorage.setItem(storageKey, value);
  return value;
}

function clearUploadIdempotencyKey(projectId: number, file: File) {
  window.localStorage.removeItem(getUploadIdempotencyStorageKey(projectId, file));
}

function getUploadIdempotencyStorageKey(projectId: number, file: File) {
  return [
    'disburse-source-upload',
    projectId,
    file.name,
    file.size,
    file.lastModified,
  ].join(':');
}

function getUploadRecordStorageKey(params: {
  projectId: number;
  filename: string;
  fileSizeBytes: number;
  lastModified: number;
}) {
  return [
    SOURCE_UPLOAD_RECORD_PREFIX,
    params.projectId,
    params.filename,
    params.fileSizeBytes,
    params.lastModified,
  ].join(':');
}

function getUploadRecordStorageKeyForFile(projectId: number, file: File) {
  return getUploadRecordStorageKey({
    projectId,
    filename: file.name,
    fileSizeBytes: file.size,
    lastModified: file.lastModified,
  });
}

export function getSourceUploadLocalRecords(projectId: number) {
  const records: SourceUploadLocalRecord[] = [];

  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);

    if (!key?.startsWith(`${SOURCE_UPLOAD_RECORD_PREFIX}:${projectId}:`)) {
      continue;
    }

    const parsed = parseSourceUploadLocalRecord(
      window.localStorage.getItem(key)
    );

    if (parsed) {
      records.push(parsed);
    }
  }

  return records.sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
  );
}

export function getSourceUploadLocalRecordForFile(projectId: number, file: File) {
  return parseSourceUploadLocalRecord(
    window.localStorage.getItem(getUploadRecordStorageKeyForFile(projectId, file))
  );
}

export function fileMatchesSourceUploadRecord(
  file: File,
  record: SourceUploadLocalRecord
) {
  return (
    file.name === record.filename &&
    file.size === record.fileSizeBytes &&
    file.lastModified === record.lastModified &&
    file.type === record.mimeType
  );
}

export function saveSourceUploadLocalRecord(record: SourceUploadLocalRecord) {
  window.localStorage.setItem(
    getUploadRecordStorageKey(record),
    JSON.stringify({ ...record, updatedAt: new Date().toISOString() })
  );
}

export function clearSourceUploadLocalRecord(record: SourceUploadLocalRecord) {
  window.localStorage.removeItem(getUploadRecordStorageKey(record));
}

export async function discardSourceUpload(record: SourceUploadLocalRecord) {
  if (record.uploadSessionId) {
    await fetch('/api/source-assets/uploads/abort', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ uploadSessionId: record.uploadSessionId }),
    });
  }

  clearSourceUploadLocalRecord(record);
  window.localStorage.removeItem(
    [
      'disburse-source-upload',
      record.projectId,
      record.filename,
      record.fileSizeBytes,
      record.lastModified,
    ].join(':')
  );
}

function parseSourceUploadLocalRecord(value: string | null) {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<SourceUploadLocalRecord>;

    if (
      typeof parsed.projectId !== 'number' ||
      typeof parsed.filename !== 'string' ||
      typeof parsed.fileSizeBytes !== 'number' ||
      typeof parsed.lastModified !== 'number' ||
      typeof parsed.mimeType !== 'string' ||
      typeof parsed.title !== 'string' ||
      typeof parsed.idempotencyKey !== 'string'
    ) {
      return null;
    }

    return {
      projectId: parsed.projectId,
      filename: parsed.filename,
      fileSizeBytes: parsed.fileSizeBytes,
      lastModified: parsed.lastModified,
      mimeType: parsed.mimeType,
      title: parsed.title,
      idempotencyKey: parsed.idempotencyKey,
      uploadSessionId:
        typeof parsed.uploadSessionId === 'number' ? parsed.uploadSessionId : null,
      uploadedPartCount:
        typeof parsed.uploadedPartCount === 'number'
          ? parsed.uploadedPartCount
          : 0,
      totalParts:
        typeof parsed.totalParts === 'number' ? parsed.totalParts : null,
      percent: typeof parsed.percent === 'number' ? parsed.percent : 0,
      status:
        parsed.status === 'uploading' ||
        parsed.status === 'paused' ||
        parsed.status === 'completed' ||
        parsed.status === 'failed'
          ? parsed.status
          : 'paused',
      updatedAt:
        typeof parsed.updatedAt === 'string'
          ? parsed.updatedAt
          : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

function uploadBlobWithProgress(params: {
  uploadUrl: string;
  method: string;
  headers: Record<string, string>;
  blob: Blob;
  signal?: AbortSignal;
  onProgress: (loaded: number) => void;
}) {
  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      params.signal?.removeEventListener('abort', handleAbort);
      callback();
    };

    const handleAbort = () => {
      xhr.abort();
      finish(() => reject(new UploadPausedError()));
    };

    if (params.signal?.aborted) {
      finish(() => reject(new UploadPausedError()));
      return;
    }

    xhr.open(params.method, params.uploadUrl);

    Object.entries(params.headers || {}).forEach(([key, value]) => {
      xhr.setRequestHeader(key, value);
    });

    params.signal?.addEventListener('abort', handleAbort, { once: true });

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        params.onProgress(event.loaded);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = xhr.getResponseHeader('ETag');

        if (!etag) {
          finish(() =>
            reject(new Error('Storage did not expose the uploaded part ETag.'))
          );
          return;
        }

        finish(() => resolve(etag));
        return;
      }

      finish(() =>
        reject(
          params.signal?.aborted
            ? new UploadPausedError()
            : new UploadInterruptedError()
        )
      );
    };

    xhr.onerror = () =>
      finish(() =>
        reject(
          params.signal?.aborted
            ? new UploadPausedError()
            : new UploadInterruptedError()
        )
      );
    xhr.onabort = () => finish(() => reject(new UploadPausedError()));
    xhr.send(params.blob);
  });
}

function getPartSize(params: {
  partNumber: number;
  partSizeBytes: number;
  totalSizeBytes: number;
}) {
  const byteStart = (params.partNumber - 1) * params.partSizeBytes;
  const byteEnd = Math.min(byteStart + params.partSizeBytes, params.totalSizeBytes);

  return Math.max(byteEnd - byteStart, 0);
}

function getUploadPercent(loadedBytes: number, totalBytes: number) {
  if (totalBytes <= 0) {
    return 0;
  }

  return Math.min(99, Math.round((loadedBytes / totalBytes) * 100));
}

export async function uploadSourceAssetMultipart(params: {
  file: File;
  projectId: number;
  title: string;
  localRecord?: SourceUploadLocalRecord | null;
  signal?: AbortSignal;
  onProgress: (progress: MultipartProgressSnapshot) => void;
}) {
  const startedAt = Date.now();
  const idempotencyKey =
    params.localRecord?.idempotencyKey ||
    getUploadIdempotencyKey(params.projectId, params.file);
  let localRecord: SourceUploadLocalRecord = params.localRecord || {
    projectId: params.projectId,
    filename: params.file.name,
    fileSizeBytes: params.file.size,
    lastModified: params.file.lastModified,
    mimeType: params.file.type,
    title: params.title,
    idempotencyKey,
    uploadSessionId: null,
    uploadedPartCount: 0,
    totalParts: null,
    percent: 0,
    status: 'uploading',
    updatedAt: new Date().toISOString(),
  };

  if (!fileMatchesSourceUploadRecord(params.file, localRecord)) {
    throw new Error('Choose the same local file to resume this upload.');
  }

  const updateLocalRecord = (next: Partial<SourceUploadLocalRecord>) => {
    localRecord = {
      ...localRecord,
      ...next,
      title: params.title,
      status: next.status || localRecord.status,
      updatedAt: new Date().toISOString(),
    };
    saveSourceUploadLocalRecord(localRecord);
  };

  updateLocalRecord({ status: 'uploading' });
  assertNotPaused(params.signal);

  try {
    const uploadSession = localRecord.uploadSessionId
      ? await readJsonResponse(
          await fetch('/api/source-assets/uploads/status', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            signal: params.signal,
            body: JSON.stringify({
              uploadSessionId: localRecord.uploadSessionId,
            }),
          })
        )
      : await readJsonResponse(
          await fetch('/api/source-assets/uploads/initiate', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            signal: params.signal,
            body: JSON.stringify({
              projectId: params.projectId,
              filename: params.file.name,
              mimeType: params.file.type,
              fileSizeBytes: params.file.size,
              idempotencyKey,
            }),
          })
        );
    const session = uploadSession.session;
    const uploadedBytesByPart = new Map<number, number>();
    const uploadedParts = new Map<number, string>(
      (uploadSession.uploadedParts || []).map(
        (part: { partNumber: number; etag: string }) => [
          part.partNumber,
          part.etag,
        ]
      )
    );
    let acknowledgedBytes = 0;

    for (const partNumber of uploadedParts.keys()) {
      const partSize = getPartSize({
        partNumber,
        partSizeBytes: session.partSizeBytes,
        totalSizeBytes: params.file.size,
      });
      acknowledgedBytes += partSize;
      uploadedBytesByPart.set(partNumber, partSize);
    }

    const restoredPercent = getUploadPercent(acknowledgedBytes, params.file.size);

    updateLocalRecord({
      uploadSessionId: session.id,
      uploadedPartCount: uploadedParts.size,
      totalParts: session.totalParts,
      percent: restoredPercent,
    });
    params.onProgress({
      loaded: acknowledgedBytes,
      total: params.file.size,
      percent: restoredPercent,
      etaSeconds: null,
      label: uploadedParts.size > 0 ? 'Resuming upload' : 'Uploading',
    });

    for (let partNumber = 1; partNumber <= session.totalParts; partNumber += 1) {
      assertNotPaused(params.signal);

      const byteStart = (partNumber - 1) * session.partSizeBytes;
      const byteEnd = Math.min(byteStart + session.partSizeBytes, params.file.size);
      const partSize = getPartSize({
        partNumber,
        partSizeBytes: session.partSizeBytes,
        totalSizeBytes: params.file.size,
      });

      if (uploadedParts.has(partNumber)) {
        continue;
      }

      const partUrl = await readJsonResponse(
        await fetch('/api/source-assets/uploads/part-url', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          signal: params.signal,
          body: JSON.stringify({
            uploadSessionId: session.id,
            partNumber,
          }),
        })
      );

      if (partUrl.alreadyUploaded) {
        uploadedParts.set(partNumber, partUrl.etag);
        uploadedBytesByPart.set(partNumber, partSize);
        acknowledgedBytes += partSize;
        const percent = getUploadPercent(acknowledgedBytes, params.file.size);
        updateLocalRecord({
          uploadedPartCount: uploadedParts.size,
          percent,
        });
        params.onProgress({
          loaded: acknowledgedBytes,
          total: params.file.size,
          percent,
          etaSeconds: null,
          label: 'Resuming upload',
        });
        continue;
      }

      const etag = await uploadBlobWithProgress({
        uploadUrl: partUrl.uploadUrl,
        method: partUrl.method,
        headers: partUrl.headers || {},
        blob: params.file.slice(byteStart, byteEnd),
        signal: params.signal,
        onProgress: (partLoaded) => {
          uploadedBytesByPart.set(partNumber, partLoaded);
          const loaded = Array.from(uploadedBytesByPart.values()).reduce(
            (sum, value) => sum + value,
            0
          );
          const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.1);
          const bytesPerSecond = loaded / elapsedSeconds;
          const remainingBytes = Math.max(params.file.size - loaded, 0);
          const percent = Math.min(
            99,
            Math.round((loaded / params.file.size) * 100)
          );

          updateLocalRecord({ percent });
          params.onProgress({
            loaded,
            total: params.file.size,
            percent,
            etaSeconds: bytesPerSecond > 0 ? remainingBytes / bytesPerSecond : null,
            label: 'Uploading',
          });
        },
      });

      await readJsonResponse(
        await fetch('/api/source-assets/uploads/part-ack', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          signal: params.signal,
          body: JSON.stringify({
            uploadSessionId: session.id,
            partNumber,
            etag,
          }),
        })
      );
      uploadedParts.set(partNumber, etag);
      uploadedBytesByPart.set(partNumber, partSize);
      acknowledgedBytes += partSize;
      updateLocalRecord({
        uploadedPartCount: uploadedParts.size,
        percent: getUploadPercent(acknowledgedBytes, params.file.size),
      });
    }

    params.onProgress({
      loaded: params.file.size,
      total: params.file.size,
      percent: 100,
      etaSeconds: 0,
      label: 'Saving upload',
    });
    updateLocalRecord({ percent: 100 });
    assertNotPaused(params.signal);

    const result = await readJsonResponse(
      await fetch('/api/source-assets/uploads/complete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: params.signal,
        body: JSON.stringify({
          uploadSessionId: session.id,
          title: params.title,
        }),
      })
    );

    clearUploadIdempotencyKey(params.projectId, params.file);
    updateLocalRecord({ status: 'completed', percent: 100 });
    clearSourceUploadLocalRecord(localRecord);
    return result;
  } catch (error) {
    if (isUploadPausedError(error) || params.signal?.aborted) {
      updateLocalRecord({
        status: 'paused',
      });
      throw new UploadPausedError();
    }

    updateLocalRecord({ status: 'failed' });

    if (isUploadInterruptedError(error)) {
      throw new UploadInterruptedError();
    }

    throw error;
  }
}
