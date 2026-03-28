const MB = 1024 * 1024;

export const MAX_SOURCE_ASSET_FILE_SIZE_BYTES = 500 * MB;

export const SOURCE_ASSET_UPLOAD_ACCEPT_ATTRIBUTE = [
  '.mp3',
  '.m4a',
  '.wav',
  '.mp4',
  '.mov',
  '.webm',
].join(',');

export const SOURCE_ASSET_ALLOWED_EXTENSIONS = [
  'mp3',
  'm4a',
  'wav',
  'mp4',
  'mov',
  'webm',
] as const;

export const SOURCE_ASSET_ALLOWED_MIME_TYPES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/x-m4a',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
  'video/mp4',
  'video/quicktime',
  'video/webm',
] as const;

export const SOURCE_ASSET_ALLOWED_FORMAT_LABEL =
  'MP3, M4A, WAV, MP4, MOV, or WEBM';

const mimeTypeSet = new Set<string>(SOURCE_ASSET_ALLOWED_MIME_TYPES);
const extensionSet = new Set<string>(SOURCE_ASSET_ALLOWED_EXTENSIONS);

export function getSourceAssetFileExtension(filename: string) {
  const normalized = filename.trim().toLowerCase();
  const extension = normalized.split('.').pop();

  if (!extension || extension === normalized) {
    return '';
  }

  return extension;
}

export function isSupportedSourceAssetUpload(
  filename: string,
  mimeType: string
) {
  const extension = getSourceAssetFileExtension(filename);

  return (
    extensionSet.has(extension) &&
    mimeTypeSet.has(mimeType.trim().toLowerCase())
  );
}

export function createSourceAssetTitleFromFilename(filename: string) {
  const trimmed = filename.trim();
  const extension = getSourceAssetFileExtension(trimmed);

  if (!extension) {
    return trimmed;
  }

  return trimmed.slice(0, -(extension.length + 1)).trim() || trimmed;
}

export function formatSourceAssetFileSize(bytes: number | null | undefined) {
  if (!Number.isFinite(bytes) || !bytes || bytes <= 0) {
    return null;
  }

  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  return `${bytes} B`;
}
