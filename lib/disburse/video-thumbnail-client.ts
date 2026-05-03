'use client';

const THUMBNAIL_MAX_HEIGHT_PX = 480;

export type ExtractedVideoThumbnail = {
  blob: Blob;
  width: number;
  height: number;
};

function isVideoFile(file: File) {
  return file.type.startsWith('video/');
}

export function extractVideoThumbnail(
  source: File | string
): Promise<ExtractedVideoThumbnail> {
  return new Promise((resolve, reject) => {
    if (source instanceof File && !isVideoFile(source)) {
      reject(new Error('Thumbnail extraction only supports video files.'));
      return;
    }

    const video = document.createElement('video');
    const objectUrl = source instanceof File ? URL.createObjectURL(source) : null;
    video.crossOrigin = 'anonymous';
    video.preload = 'metadata';
    video.playsInline = true;
    video.muted = true;

    let hasCaptured = false;

    function cleanup() {
      video.pause();
      video.removeAttribute('src');
      video.load();

      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    }

    function fail(error: Error) {
      cleanup();
      reject(error);
    }

    function captureFrame() {
      if (hasCaptured || !video.videoWidth || !video.videoHeight) {
        return;
      }

      hasCaptured = true;

      const height = Math.min(video.videoHeight, THUMBNAIL_MAX_HEIGHT_PX);
      const width = Math.max(
        1,
        Math.round((height / video.videoHeight) * video.videoWidth)
      );
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');

      if (!context) {
        fail(new Error('Canvas context unavailable.'));
        return;
      }

      try {
        context.drawImage(video, 0, 0, width, height);
      } catch {
        fail(new Error('Thumbnail frame could not be read.'));
        return;
      }

      canvas.toBlob(
        (blob) => {
          if (!blob) {
            fail(new Error('Thumbnail image could not be encoded.'));
            return;
          }

          cleanup();
          resolve({ blob, width, height });
        },
        'image/jpeg',
        0.72
      );
    }

    video.addEventListener('loadeddata', () => {
      if (video.currentTime > 0) {
        captureFrame();
        return;
      }

      const seekTime = Math.min(0.1, Math.max(video.duration * 0.01, 0));

      if (Number.isFinite(seekTime) && seekTime > 0) {
        video.currentTime = seekTime;
        return;
      }

      captureFrame();
    });

    video.addEventListener('seeked', captureFrame);
    video.addEventListener('error', () => {
      fail(new Error('Thumbnail extraction failed.'));
    });

    video.src = objectUrl || String(source);
  });
}

export async function uploadSourceAssetThumbnail(params: {
  sourceAssetId: number;
  file: File;
}) {
  if (!isVideoFile(params.file)) {
    return null;
  }

  const thumbnail = await extractVideoThumbnail(params.file);
  const formData = new FormData();
  formData.set('file', thumbnail.blob, 'thumbnail.jpg');
  formData.set('width', String(thumbnail.width));
  formData.set('height', String(thumbnail.height));

  const response = await fetch(`/api/source-assets/${params.sourceAssetId}/thumbnail`, {
    method: 'POST',
    body: formData,
  });
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(body?.error || 'Thumbnail upload failed.');
  }

  return body;
}
