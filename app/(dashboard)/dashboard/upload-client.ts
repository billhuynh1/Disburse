'use client';

type ProgressSnapshot = {
  loaded: number;
  total: number;
  percent: number;
  etaSeconds: number | null;
};

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

export async function uploadSourceAssetViaServer(params: {
  file: File;
  projectId: number;
  title: string;
}) {
  const formData = new FormData();
  formData.append('projectId', String(params.projectId));
  formData.append('title', params.title);
  formData.append('file', params.file);

  return await readJsonResponse(
    await fetch('/api/source-assets/uploads/file', {
      method: 'POST',
      body: formData
    })
  );
}
