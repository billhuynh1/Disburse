import { ContentPackKind, RenderedClipStatus } from '../db/schema.ts';

type NavigationContentPack = {
  kind: string;
  sourceAssetId: number;
  shortFormGenerationMode: string;
  generationRunId: string | null;
  clipCandidates: {
    id: number;
    generationRunId: string;
    currentRenderConfigId: number | null;
    renderedClips: {
      clipCandidateId: number;
      clipRenderConfigId: number | null;
      generationRunId: string;
      status: string;
    }[];
  }[];
};

export function hasReadyCurrentSnapshotClip(
  contentPacks: NavigationContentPack[],
  sourceAssetId: number | null
): boolean {
  const pack = contentPacks.find(
    (pack) => pack.kind === ContentPackKind.SHORT_FORM_CLIPS &&
      (sourceAssetId === null || pack.sourceAssetId === sourceAssetId)
  );

  if (pack?.shortFormGenerationMode !== 'snapshot' || !pack.generationRunId) {
    return false;
  }

  return pack.clipCandidates.some((candidate) =>
    candidate.generationRunId === pack.generationRunId &&
    candidate.currentRenderConfigId !== null &&
    candidate.renderedClips.some((clip) =>
      clip.clipCandidateId === candidate.id &&
      clip.generationRunId === pack.generationRunId &&
      clip.clipRenderConfigId === candidate.currentRenderConfigId &&
      clip.status === RenderedClipStatus.READY
    )
  );
}
