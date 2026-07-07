import { SourceAssetType, TranscriptStatus } from '../db/schema.ts';

export function shouldEnqueueTranscriptionFromSetup(sourceAsset: {
  assetType: string;
  transcript?: {
    status: string;
  } | null;
}) {
  return (
    sourceAsset.assetType === SourceAssetType.UPLOADED_FILE &&
    sourceAsset.transcript?.status !== TranscriptStatus.READY
  );
}
