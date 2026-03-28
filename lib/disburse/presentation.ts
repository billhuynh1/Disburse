import {
  ContentPackStatus,
  SourceAssetStatus,
  SourceAssetType,
  TranscriptStatus
} from '@/lib/db/schema';
import { formatSourceAssetFileSize as formatFileSize } from '@/lib/disburse/source-asset-upload-config';

export function getWorkflowStatusClasses(status: string) {
  switch (status) {
    case SourceAssetStatus.READY:
    case TranscriptStatus.READY:
    case ContentPackStatus.READY:
      return 'bg-green-100 text-green-700';
    case SourceAssetStatus.PROCESSING:
    case TranscriptStatus.PROCESSING:
    case ContentPackStatus.GENERATING:
      return 'bg-amber-100 text-amber-700';
    case SourceAssetStatus.FAILED:
    case TranscriptStatus.FAILED:
    case ContentPackStatus.FAILED:
      return 'bg-red-100 text-red-700';
    default:
      return 'bg-gray-100 text-gray-700';
  }
}

export function getSourceAssetTypeLabel(assetType: string) {
  switch (assetType) {
    case SourceAssetType.UPLOADED_FILE:
      return 'Uploaded file';
    case SourceAssetType.YOUTUBE_URL:
      return 'YouTube URL';
    case SourceAssetType.PASTED_TRANSCRIPT:
      return 'Pasted transcript';
    default:
      return assetType.replaceAll('_', ' ');
  }
}

export function getContentPackStatusMessage(status: string) {
  switch (status) {
    case ContentPackStatus.GENERATING:
      return 'This content pack is scaffolded and marked as generating for a future repurposing run.';
    case ContentPackStatus.READY:
      return 'This content pack is ready to hold generated channel outputs.';
    case ContentPackStatus.FAILED:
      return 'This content pack remains visible, but its workflow is currently marked failed.';
    default:
      return 'This content pack is queued for future repurposing.';
  }
}

export function formatSourceAssetFileSize(value: number | null | undefined) {
  return formatFileSize(value);
}
