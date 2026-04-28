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
      return 'bg-emerald-400/12 text-emerald-200 ring-emerald-300/20';
    case SourceAssetStatus.PROCESSING:
    case TranscriptStatus.PROCESSING:
    case ContentPackStatus.GENERATING:
      return 'bg-amber-400/12 text-amber-200 ring-amber-300/20';
    case SourceAssetStatus.FAILED:
    case TranscriptStatus.FAILED:
    case ContentPackStatus.FAILED:
      return 'bg-red-400/12 text-red-200 ring-red-300/20';
    default:
      return 'bg-muted text-muted-foreground ring-border/80';
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
