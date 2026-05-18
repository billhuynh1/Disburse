import { ContentPackStatus, SourceAssetType } from '../db/schema.ts';

export function getRecoverableShortFormPackStatus(params: {
  sourceAssetType: string;
  currentGenerationCandidateCount: number;
  hasActiveProcessing: boolean;
}) {
  if (params.currentGenerationCandidateCount === 0) {
    return null;
  }

  if (params.sourceAssetType !== SourceAssetType.UPLOADED_FILE) {
    return ContentPackStatus.READY;
  }

  if (params.hasActiveProcessing) {
    return ContentPackStatus.GENERATING;
  }

  return null;
}
